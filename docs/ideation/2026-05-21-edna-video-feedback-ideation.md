---
date: 2026-05-21
topic: edna-video-feedback
focus: Improve messaging feedback when user asks Edna to create a video — immediate acknowledgement (primary) + real-time progress updates (bonus)
mode: repo-grounded
---

# Ideation: Edna Video-Generation Messaging Feedback

## Grounding Context

### Codebase Context

**Project shape:** NanoClaw — single Node.js (TypeScript) orchestrator + Claude Agent SDK containers. Channels (Slack/Telegram/WhatsApp/Discord/Gmail) are self-registering skills. Inbound: channel → SQLite → agent container → IPC (filesystem JSON) → orchestrator → channel.

**How replies work today:**
- `src/index.ts:323` — orchestrator sends `"Got it, working on it..."` immediately via `deduplicatedSend`
- `setTyping(true)` → agent runs (10–30s+ for Veo) → output streams (5s dedup window) → `setTyping(false)`
- Commit c30f732 added `routeFailureNotice(channels, jid, kind)` in `src/router.ts:93-130` with `pre|mid|silent` failure copies; small router-level fn; channel-agnostic; unit-testable
- `outputSentToUser` flag at `src/index.ts:344` controls retry — flips true when agent streams real text

**Video pipeline state (feat/edna-video-generation branch):**
- `container/skills/veo/generate_video.py` blocks on Veo long-poll, prints `Polling... (Ns elapsed)` every ~10s to stdout, emits terminal `MEDIA: <path>` token
- Polling lines go to **agent stdout, not the user** — the data exists, only routing is missing
- `Channel.sendVideo` ships (Slack via `files.uploadV2`); IPC `videos/` namespace with `.ack.json` companions
- Known risk: 60s+ Veo render can exceed `ContainerConfig.timeout` (5min default) → container killed mid-render → silent/pre failure mode

**Existing patterns to mirror:**
- `videos/` IPC namespace with `.ack.json` companions
- Optional `setTyping?(jid, isTyping)` channel method with deliberate no-op fallback (Slack Bot API has no typing endpoint)
- `routeFailureNotice` discriminated-union dispatcher
- `formatOutbound(rawText, channel?)` runs all outbound through per-channel formatting (Slack mrkdwn, etc.)

**Pain points (current UX):**
1. Silent wait: `"Got it..."` → 10–30s+ silence; typing doesn't persist through Veo poll
2. No progress signal during render
3. No receipt confirmation on inbound video upload
4. Late failure: Veo timeout/quota errors surface only after waiting
5. No cost/ETA hint ($2.40 for 16s standard; $7+ for `--long`)
6. 5s dedup window can drop legitimate duplicate sends

**Leverage points:**
- `src/index.ts` extend `deduplicatedSend` (bypass dedup for "progress" types) or add `sendProgress` helper
- `src/ipc.ts` new `progress/` namespace mirroring `videos/` shape
- `src/types.ts` + `src/router.ts` add optional `sendStatus`/`updateMessage` channel methods
- `container/skills/veo/` capture stderr; new MCP `send_progress` tool
- `groups/main/CLAUDE.md` agent guidance — but defense-in-depth: don't rely solely on agent following prompts

### Past Learnings

1. `routeFailureNotice` shape is the template — discriminated-union kinds with distinct copy, channel-agnostic dispatch, unit-testable
2. Decide intermediate-progress vs `outputSentToUser` — progress messages should NOT flip the flag, so retry remains safe
3. No structured field unless real downstream consumer — progress flows container → orchestrator → channel, not to agent
4. Veo polling lines exist but aren't routed; two viable paths: agent-driven (model-discretion, fragile) vs code-driven (defense-in-depth)
5. WhatsApp `StatusTracker` (skill/reactions branch) — forward-only emoji state machine, SQLite-persisted; reactions are channel-portable (Slack `reactions.add`, Telegram 7.x, Discord native)
6. Reuse `deduplicatedSend` — any new path bypassing it risks double-posting on retry
7. Two-layer safety: code-side enforcement + CLAUDE.md prose; never just CLAUDE.md

### External Context

- **Slack AI Assistant API:** `assistant.threads.setStatus(status, loading_messages[])` — fires immediately, rotates up to 10 strings, 2min hard timeout, 600 req/min rate limit. `chat.startStream / appendStream(plan|task_update) / stopStream` for progressive text. `chat.update` 3-sec floor per message. Global rate limit 1 msg/sec/channel — progress and final delivery share one bucket.
- **Telegram:** `sendChatAction(upload_video)` 5s TTL, re-fire loop; `editMessageText` for in-place rewrite.
- **Discord:** `interaction.deferReply(thinking=True)` extends to 15min window; typing TTL ~10s; `interaction.followup.edit()` for updates.
- **WhatsApp:** 25s typing TTL; Jan 2026 policy bans "general-purpose AI chatbots" — task-scoped (video generation) may qualify but policy ambiguous; live risk for WhatsApp channel.
- **Claude Agent SDK event stream** (`managed-agents-2026-04-01`): `agent.tool_use` fires when tool selected (before round-trip), `agent.thinking`, `agent.tool_result`, `includePartialMessages: true`.
- **Cross-domain:** GitHub Actions → Slack post-ts → update-on-completion is the dominant CI pattern; Devin appends-to-thread instead of edit-in-place; ride-hailing finding — users want confidence + ETA, not real-time accuracy; HCI progress-bar research — users tolerate 3-4x longer waits with any indicator, even fake/inaccurate.
- **Documented failure modes:** stale indicator on abandonment (must clear on error), race (Veo returns in <2s before ack), rate-limit bleed (dblock.org Mar 2026 postmortem of exactly this on Slack), typing TTL dropout, WhatsApp policy boundary, retry flooding (idempotency-guard).

## Topic Axes

1. Acknowledgement (first 0–2s response) — content, format, differentiation by request type
2. In-progress signaling (heartbeat during render) — stage updates, edit-in-place vs append, intermediate previews
3. Channel-specific UX — Slack assistant API, Telegram TTL loops, Discord deferred interactions, WhatsApp constraints
4. Failure & race paths — timeout, quota, retry, cancellation, race, abandonment, container-killed-mid-render
5. Plumbing & shared infrastructure — IPC `progress/` namespace, optional Channel methods, MCP `send_progress` tool, container-skill stderr piping

## Ranked Ideas

### 1. Operation-aware first ack with cost/ETA/cancel (LongRunningOpContract)

**Description:** Replace the bland `"Got it, working on it..."` (src/index.ts:323) with intent-aware ack copy for video requests: `"🎬 Rendering ~16s Veo video (~$2.40, ~60–90s). Reply 'cancel' to stop."` The contract is a typed convention container skills can opt into — `generate_video.py` declares `estimated_seconds`, `estimated_cost_usd`, `cancel_token`; orchestrator parses these (or detects from prompt flags) and auto-enriches the ack. Non-video requests keep a light ack. Includes a "stream interpreted prompt back" variant — `"Rendering: 'A golden retriever conducting a symphony, 16s, cinematic.' Reply 'cancel' if that's wrong."` — to convert the ack into a correctness check before $2.40 burns.

**Axis:** Acknowledgement

**Basis:** `direct:` Pain point #5 in grounding ("No cost/ETA hint — $2.40 for 16s standard; $7+ for `--long`"); cost-table-by-flag is deterministic at command time. `direct:` `src/index.ts:323` hard-codes the same generic ack regardless of operation. `external:` HCI progress-bar research — users tolerate 3-4x longer waits when shown *any* indicator; ride-hailing finding — users want confidence + ETA, not real-time accuracy.

**Rationale:** Directly answers the user's stated primary goal. "Got it" is a lie when the wait is 90s; naming the operation + cost + ETA converts dread-silence into informed-waiting. The cancel affordance front-loads the most expensive error mode (wrong prompt interpretation) into a cheap pre-render window. Generalizes via `LongRunningOpContract` so nano-banana-pro and future long-running skills inherit the pattern.

**Downsides:** Requires intent classification at orchestrator time (regex on text, or wait for `agent.tool_use` event from SDK — see Idea 7). Cancel-token plumbing is new. Some users may find the dollar figure off-putting; needs a per-group "show cost" toggle.

**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

---

### 2. Inbound-video receipt at materialization (no agent involvement)

**Description:** When `materializeAttachment` writes a video to `groups/<name>/inbox/`, emit a channel-side ack immediately — before the agent even wakes up. Pull duration + size from the materialized file (already on disk by ack time). Optionally extract one frame via the existing `extract_frame.py` and post it back as a "is this the frame you want me to analyze?" confirmation. Sample copy: `"Got your video (12s, 4.2MB). Pulling reference frame..."`

**Axis:** Acknowledgement

**Basis:** `direct:` Pain point #3 in grounding — "No receipt confirmation on inbound video upload." `direct:` Commits 109d258 (`materializeAttachment` to `inbox/`) and 19a723f (inbox/ contract documented) just shipped the materialization point; nothing yet emits a receipt from it. `direct:` `extract_frame.py` already exists for the frame-confirmation variant.

**Rationale:** Cheapest big-win in the survivor set. Currently uploading a video to Edna is an act of faith — generic "Got it" with no signal the bytes arrived intact. The orchestrator has the file at ack time; not surfacing that is leaving free reassurance on the table. The fix is small and isolated (one hook on the materialization write), and it cannot regress when the agent's behavior changes — it's a property of file landing on disk.

**Downsides:** Extracting a frame mid-flow costs ~100–300ms of ffmpeg time per upload — fine for single-video requests, could batch-stall on bulk uploads. The frame-confirmation variant adds an image attachment to the channel before the agent runs.

**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

---

### 3. `progress/` IPC namespace + structured signal + container-side helper

**Description:** Mirror the proven `videos/` IPC namespace: `data/ipc/<group>/progress/<id>.json` with discriminated `kind` (`queued | running | stage | preview | done`) and structured payload (`stage`, `elapsed_sec`, `eta_sec?`, `label?`, `percent?`). Add a tiny `container/lib/progress.py` helper exposing a context manager — `with progress("video", op_id, total_seconds_estimate=60) as p: p.update("rendering", percent=18)` — that handles atomic writes and respects Slack's 3s update floor at the producer. `generate_video.py`'s polling loop wraps in it; nano-banana-pro adopts in two lines; future Python skills get progress for free. Orchestrator-side: new `routeProgressNotice(channels, jid, kind, ctx)` router mirroring `routeFailureNotice` shape (unit-testable, channel-agnostic, no-op on unreachable channel). Recommended progress-line format: SBAR-style structured slots (*Stage* / *Elapsed* / *ETA* / *Next*) with mixed-confidence rendering (bold for measured, plain for estimated, em-dash for unknown). Operator-vs-user split: the same structured event stream can drive operator dashboards as a second consumer without new infrastructure.

**Axis:** In-progress signaling / Plumbing & shared infrastructure

**Basis:** `direct:` `videos/` IPC namespace with `.ack.json` companions + `setTyping?` optional-method pattern + `routeFailureNotice` discriminated-union template are all proven in this codebase. `direct:` `generate_video.py` already prints `Polling... (Ns elapsed)` to stdout every ~10s — the data exists, only routing is missing. `external:` SBAR clinical handoff and Deutsche Bahn departure board conventions are validated patterns for slotted progress with confidence tiers.

**Rationale:** This is the substrate that makes most other ideas cheap to ship. Without it, every channel/skill reinvents progress UX. Same primitive serves nano-banana-pro, scheduled-task heartbeats, future audio/3D/code-generation flows. Code-driven heartbeat (vs agent-discretion) honors the defense-in-depth principle from c30f732's reply-on-failure work: a model that ignores the prompt instruction still produces safe UX.

**Downsides:** Adds an IPC namespace and a small Python lib that becomes a contract container-skill authors have to learn. Throttle-at-producer choice means changing channel rate limits requires updating producers — but that's the right side to put it on per the dblock.org rate-limit postmortem.

**Confidence:** 85%
**Complexity:** Medium
**Status:** Explored

---

### 4. Reaction-based ack on the user's message (kill or downgrade "Got it...")

**Description:** Replace the text ack at `src/index.ts:323` with a reaction on the user's original message — `:eyes:` (received) → `:gear:` (rendering) → `:film_frames:` (finalizing) → `:white_check_mark:` (done) / `:x:` (failed). Forward-only emoji state machine, SQLite-persisted, channel-portable. Slack `reactions.add`, Telegram Bot API 7.x reactions, Discord native reactions, WhatsApp via the `skill/reactions` branch's `StatusTracker`. Final video upload becomes the only Edna-authored *message*; the channel itself carries the progress state. Two variants worth considering: (a) full kill of "Got it..." — reaction-only; (b) deferred ack — only send the text ack if work hasn't completed within 1.5s, reaction fires immediately regardless. Variant (b) solves the documented Veo-returns-in-<2s race (failure mode #2).

**Axis:** Acknowledgement / Channel-specific UX

**Basis:** `direct:` Past learning #5 — `StatusTracker` (forward-only emoji state machine, SQLite-persisted, retried) exists in `skill/reactions` branch. `direct:` Slack `reactions.add`, Telegram 7.x reactions, Discord native are all documented and channel-portable. `external:` GitHub Actions → Slack pattern uses reaction emoji on the trigger message (`eyes` → `gear` → `white_check_mark` / `x`) as canonical CI progress UI.

**Rationale:** Reactions sit in a separate rate-limit bucket from `chat.postMessage` on Slack — solves the documented rate-limit-bleed failure (mode #3, dblock.org postmortem) by moving heartbeat off the message bucket entirely. Zero thread clutter. Side-steps WhatsApp Jan 2026 policy concerns since a reaction is not a chatbot-style text reply. Brings a dormant feature branch (`skill/reactions`) into the critical path with a generic substrate.

**Downsides:** Reactions are less discoverable than text — new users may miss the eyes emoji. Some channels (Gmail) have no reaction equivalent — need text fallback. Merging `skill/reactions` (currently WhatsApp-only) requires generalizing its substrate. Variant (a) is a stronger statement but variant (b) is more conservative.

**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

---

### 5. Heartbeat watchdog → automatic `routeFailureNotice` on staleness

**Description:** Side-by-side with the `progress/` IPC consumer, run a per-op watchdog: if a `progress/<id>.json` has been "running" but hasn't been updated in >90s (configurable; >Slack's 2min status timeout, >Telegram's 5s typing TTL), automatically fire a new failure kind — `routeFailureNotice(jid, 'silent_progress')` — with copy like `"⚠️ Render stalled — checking on it / want me to retry?"`. Same watchdog catches container-killed-mid-render (Veo 60s+ exceeds 5min container timeout), network partitions, Veo quota stalls. Stage-aware failure copy when possible: cache last-known stage from progress events; failure copy names it (`"Veo rendered fine, hit an error during stitch"`) — ATC-handoff pattern.

**Axis:** Failure & race paths

**Basis:** `direct:` Grounding-documented risk: "60s+ Veo render can exceed `ContainerConfig.timeout` (5min default) → container killed mid-render → silent/pre failure mode." `direct:` `routeFailureNotice` in `src/router.ts:93-130` is the discriminated-union template; adding `silent_progress` kind is a 5-line diff + a test in `routing.test.ts`. `direct:` Documented failure modes #1 (stale indicator on abandonment) and #4 (typing TTL dropout) are both manifestations of this class.

**Rationale:** Load-bearing for the "no silence" guarantee that c30f732 introduced. The reply-on-failure work patched the silence problem for fast failures; this extends it to long-running failures the orchestrator currently can't detect without a heartbeat to watch. Generalizes — same watchdog protects nano-banana-pro, scheduled tasks, any long-running op. Composes with Idea 3 (consumes its progress events).

**Downsides:** Requires the container side to actually emit progress events at a regular cadence (depends on Idea 3 shipping). Threshold tuning (60s? 90s? 120s?) is empirical — too aggressive produces false-positive "stalled" notices. Adds an orchestrator-side timer per in-flight op.

**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

---

### 6. Edit-in-place lifecycle: `MessageHandle` + collapse ack→progress→final into one anchor

**Description:** Two-part proposal. **(a)** Add `MessageHandle` as the return type of `Channel.sendMessage`/`sendVideo` (opaque, channel-specific — `ts` on Slack, `message_id` on Telegram, `id` on Discord). Add optional `Channel.updateMessage?(handle, newText)` to the channel interface. Falls back to fresh `sendMessage` when not implemented (Gmail, WhatsApp Business with constraints). **(b)** Use it to collapse the ack, progress messages, and final delivery into one message anchor edited through its lifecycle: `"Got it, working on it..."` → `"Rendering frame 18/96 (~45s left)"` → final video. Failure also overwrites the anchor: `"❌ Veo timed out after 5min — retry?"`. One message per request, monotonic state transitions, no orphaned ghosts.

**Axis:** Plumbing & shared infrastructure

**Basis:** `direct:` Slack `chat.update`, Telegram `editMessageText`, Discord `interaction.followup.edit` all exist (cited in grounding) — every supported channel except Gmail/WhatsApp-Business has native edit-in-place. `external:` Slack docs: "only call `chat.update` once every 3 seconds with new content" — the floor lets a single anchor express many state transitions safely. `reasoned:` Documented race condition (failure mode #2: Veo returns in <2s → out-of-order) is structurally impossible with a single message anchor.

**Rationale:** Halves rate-limit footprint (one message budget instead of N). Eliminates the out-of-order race entirely. Forces design clarity — every request resolves to one terminal message state. Unlocks edit-in-place for any future progress UX, not just video.

**Downsides:** Changes the `Channel` interface signature — every channel impl needs a return-type bump. Edit-in-place loses notification "ping" on most channels (users may want the bell on the final video specifically — could combine: edit through render, send fresh message on completion). Conflicts with Idea 4's reaction-only-ack variant (a) — they're alternatives, not complements; pick one or layer reactions over the edited anchor.

**Confidence:** 70%
**Complexity:** Medium-High
**Status:** Unexplored

---

### 7. Claude Agent SDK `includePartialMessages` hook → automatic "calling X..." narration

**Description:** In `container-runner.ts` (or wherever the Agent SDK is invoked), enable `includePartialMessages: true` and hook `agent.tool_use` events. When a known long-running tool is selected (`generate_video`, `nano-banana-pro`, future audio/3D), write a `progress/<id>.json` with `kind: 'running'` and tool-specific copy: `"📹 Calling Veo..."`, `"🖼️ Painting with nano-banana..."`. Fires within ~500ms of Claude deciding what to do — *before* the tool round-trip completes. Distinct second-stage ack between the generic orchestrator "Got it" and the tool's own progress events.

**Axis:** Acknowledgement / In-progress signaling

**Basis:** `external:` Claude Agent SDK event stream (`managed-agents-2026-04-01`): `agent.tool_use` fires when tool selected (before round-trip), `agent.thinking`, `agent.tool_result`, `includePartialMessages: true` for streaming. Cursor, Devin, Copilot Workspace all narrate from tool-selection events (named pattern). `direct:` Adopting this completes the "code-driven progress" defense-in-depth principle from learnings — agent narration becomes a property of the tool-call graph, not of model discretion.

**Rationale:** Highest *future*-leverage idea in the survivor set. Every new long-running MCP tool added gets free intermediate "now calling X..." narration with one config line — no per-tool plumbing, no CLAUDE.md prose to maintain. Removes the entire class of "did the agent remember to update the user" failures.

**Downsides:** Requires Claude Agent SDK version that exposes the events (verify current container-runner deps). Requires hooking the stream in `container-runner.ts` — non-trivial; current container is invoked, not subscribed-to. Tool-name → copy mapping needs to be maintained somewhere (probably `container/lib/progress.py` or a registry).

**Confidence:** 65%
**Complexity:** Medium
**Status:** Unexplored

---

## Cross-Cutting Combinations

Three combinations that compose particularly well — natural sequencing paths:

- **Foundation path** = Idea 3 (`progress/` namespace + helper) + Idea 5 (watchdog) + Idea 6 (MessageHandle). Ships the substrate; everything else gets cheap.
- **Quickest user-visible wins** = Idea 1 (operation-aware ack) + Idea 2 (inbound-video receipt) + Idea 4 variant (b) (deferred text-ack + immediate reaction). All can ship without touching the channel interface.
- **Full lifecycle** = Idea 1 + Idea 3 + Idea 6 + Idea 4 variant (a). Reaction acks the receipt; one edited message anchor carries cost/ETA → render progress → final video.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Stream every Veo poll line as typed monologue | Duplicates stage-transition approach with worse signal-to-noise; the "infinite-rate" argument is stronger — attention is the constraint, not API rate |
| 2 | Render progress bar AS first frame, preview-card images | Too expensive relative to value when reactions + edit-in-place already cover silence pain; speculative on Veo intermediate-frame access |
| 3 | Bootloader verbose mode (opt-in firehose) | Niche operator/power-user feature; better as a brainstorm variant of Idea 3, not core path |
| 4 | D&D DM narration — prompt-derived diegetic line | Risk of AI-slop feel; copy decision better made after structural ideas ship |
| 5 | 5-hour render → detach Veo poll from container lifetime | Scope-adjacent: real architectural concern for `--long` renders but bigger ideation than "messaging feedback"; flag for separate ideation if `--long` becomes common |
| 6 | Progress narrative IS the deliverable — Slack canvas / Notion lifecycle artifact | Scope overrun: "messaging feedback for video" doesn't need a durable lifecycle artifact in v1; revisit if telemetry needs surface |
| 7 | Ephemeral progress in multi-user channels | Channel-specific (Slack/Discord only) niche; lower priority than core ack/progress; revisit after foundation ships |
| 8 | Dedup by type/msg-id not time | Folded into Idea 3 — when progress events carry `{taskId, kind, seq}` the time-based 5s window is no longer load-bearing for those messages |
| 9 | SBAR heartbeat / departure board confidence tiers | Folded into Idea 3 as the recommended progress-line format |
| 10 | ATC stage-aware failure copy | Folded into Idea 5 — watchdog uses cached last-known stage to enrich failure notices |
| 11 | Operator-vs-user progress split / structured to two sinks | Folded into Idea 3 — the structured event stream can drive operator dashboards as a second consumer without new infrastructure |
| 12 | Slot machine staged reveal | Speculative on Veo intermediate-state access; revisit if Veo API exposes per-frame progress |
| 13 | No copy at all — failure via reaction only | Folded into Idea 4 — reaction-state-machine already covers signal; prose detail stays for actionable failures (retry, change prompt) |

**Axis coverage on survivors:**
- Axis 1 (Acknowledgement): Ideas 1, 2, 4, 7 (heaviest, matching user's stated primary goal)
- Axis 2 (In-progress signaling): Ideas 3, 7 (and Idea 6 enables)
- Axis 3 (Channel-specific UX): Idea 4 (and every idea touches the channel interface)
- Axis 4 (Failure & race paths): Idea 5
- Axis 5 (Plumbing & shared infrastructure): Ideas 3, 6

All axes have survivor coverage; no recovery dispatch needed.
