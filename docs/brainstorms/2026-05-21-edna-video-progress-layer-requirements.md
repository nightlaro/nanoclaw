---
date: 2026-05-21
topic: edna-video-progress-layer
---

# Edna Video Progress-Feedback Layer

## Summary

Build a structured progress-event layer that lets any video-model script emit lifecycle events; the orchestrator edits one anchor message per request in a SBAR-style structured format and overwrites the same anchor on failure; a watchdog detects stalls so silence is impossible. Reuses the existing IPC, optional-channel-method, and discriminated-failure-dispatcher patterns. Veo ships as the v1 producer; future video models (Omni, Sora, next) inherit by importing one helper.

---

## Problem Frame

The user asks Edna to generate a video. Today they get `"Got it, working on it..."` and then 30s–3min of silence while the Veo poll loop runs inside the container. Two pain points:

- **No mid-render signal.** The Veo polling script already prints `Polling... (Ns elapsed)` every ~10s, but that output never leaves the container — it goes to agent stdout, not to the user. The user has no way to know whether the render is progressing or stuck, so they re-query Edna ("are you still working?") or assume failure and walk away.
- **Container-killed-mid-render is silent.** The container has a 5-minute timeout; a `--long` Veo render or a slow provider can exceed it. When that happens, the container is killed mid-poll with no terminal event, the agent never resumes, and the user sees the original `"Got it..."` followed by nothing. The recent reply-on-failure work (`routeFailureNotice`, commit c30f732) patched fast failures but cannot detect this case because no event ever fires.

These pains compound across video models. The user wants to swap providers (Veo today, Omni or Sora next), and any per-script relay logic would re-implement the same UX for each one.

---

## Actors

- A1. **User**: the human waiting in the chat for the requested video.
- A2. **Edna (agent)**: the Claude Agent SDK process inside the container that invokes the video producer script.
- A3. **Video producer (container script)**: the script that drives the video API (Veo's `generate_video.py` today; Omni / Sora / future equivalents tomorrow) and emits progress events.
- A4. **Orchestrator**: the host-side Node.js process that consumes progress events and routes to channels.
- A5. **Channel**: the per-platform adapter (Slack, Telegram, Discord, WhatsApp, Gmail) that renders progress to the user's chat.
- A6. **Operator**: the maintainer who configures the watchdog threshold and reviews stall events.

---

## Key Flows

- F1. **Happy-path video render**
  - **Trigger:** User sends a video-generation request; agent invokes the video producer.
  - **Actors:** A1, A3, A4, A5
  - **Steps:**
    1. Producer starts and emits an opening lifecycle event (request acknowledged at producer level).
    2. Orchestrator receives the event and posts the initial anchor message rendered in the structured-slot format.
    3. Producer emits stage transitions (queued → rendering → finalizing → uploading) plus throttled tick updates with elapsed/ETA/percent (when known).
    4. Orchestrator edits the anchor message in place on each event.
    5. Producer emits a terminal "done" event with the deliverable artifact location.
    6. Orchestrator overwrites the anchor with the final completion rendering, then delivers the video.
  - **Outcome:** User sees exactly one progress message that evolves into the final delivery.
  - **Covered by:** R1, R2, R5, R9, R11

- F2. **Producer-detected failure (provider quota, prompt-rejected, API error)**
  - **Trigger:** Video API returns an error the producer can interpret.
  - **Actors:** A3, A4, A5
  - **Steps:**
    1. Producer catches the error and emits a terminal "failed" event with a producer-known reason and the last-known stage.
    2. Orchestrator overwrites the anchor with a failure rendering naming the stage and reason; no new message is posted.
  - **Outcome:** The original anchor becomes the failure message; thread shows one request and one response.
  - **Covered by:** R4, R13

- F3. **Orchestrator-detected stall (container killed, IPC stalled, provider hang)**
  - **Trigger:** No progress event arrives for a request for longer than the watchdog threshold while the request is still in-flight.
  - **Actors:** A4, A5, A6
  - **Steps:**
    1. Watchdog notices the staleness threshold has been crossed for an active request.
    2. Watchdog dispatches an automatic failure-overwrite through the existing failure-notice path, passing the anchor handle.
    3. Orchestrator overwrites the anchor with a "stalled, last seen at <stage>" rendering.
  - **Outcome:** No request can produce silent abandonment; the user sees a stall notice within bounded time.
  - **Covered by:** R14, R15

---

## Requirements

**Producer responsibilities**
- R1. Each video-generation container script emits a sequence of lifecycle events to a structured progress channel from the moment work begins until a terminal event (success or failure) is emitted.
- R2. Each event includes the request identifier, current stage label, elapsed time, optional ETA, optional percent-complete, optional next-stage hint, and optional model-id tag.
- R3. The producer throttles emissions to respect the smallest minimum-update-interval among the channels involved in the request, so progress traffic cannot starve final delivery on rate-limited platforms.
- R4. The producer emits exactly one terminal event for each request, marking it either completed (with the deliverable artifact location) or failed (with a producer-known reason and the last-known stage).

**Helper API**
- R5. A reusable container-side helper provides a context-manager-style API so a producer script can adopt progress signaling in roughly two lines (import + with-statement).
- R6. The helper handles request-ID propagation, event ordering, throttling, and write atomicity on the producer's behalf.

**Event semantics**
- R7. Progress events for an in-flight request persist on disk until the terminal event is emitted, so the orchestrator-side watchdog can detect staleness without racing the consumer.
- R8. Multiple events for the same request are reconciled latest-wins; the producer is not responsible for keeping historical events.

**Orchestrator routing**
- R9. The orchestrator maintains a single anchor message handle per video request and updates that anchor through the lifecycle on edit-capable channels.
- R10. On channels that do not implement update-in-place, the orchestrator falls back to appending a new message only on stage transitions, suppressing intra-stage tick and percent updates so the user is not spammed with successive messages.
- R11. The user-facing rendering presents stage, elapsed, ETA (when known), and next-stage hint in a stable, scannable structured-slot format.
- R12. The `Channel` interface gains an optional method for update-in-place that channels implement when their platform supports it, following the existing optional-method convention (`setTyping?`, `sendImage?`, `sendVideo?`).

**Failure path & watchdog**
- R13. Producer-known failures surface via the terminal "failed" event; the orchestrator overwrites the anchor message in place with a failure rendering that names the last-known stage when available.
- R14. The orchestrator runs a watchdog that fires an automatic failure-overwrite when progress events for an active request go stale beyond a configured threshold, so container crashes, IPC stalls, and provider hangs cannot produce silent abandonment.
- R15. The watchdog-fired failure flows through the existing failure-notice dispatcher with the anchor handle, extending — not duplicating — the discriminated-union pattern already in place.

**Anchor durability**
- R16. The anchor handle for each in-flight request persists in the existing data store so that an orchestrator restart mid-render still resolves subsequent edits to the correct message on resumption.

**Model agnosticism**
- R17. The event schema and helper API contain no field that is specific to one video provider; a script for a new video model adopts the layer without schema changes.

---

## Acceptance Examples

- AE1. **Covers R3.** When a user requests a video on a Slack channel whose minimum update interval is 3 seconds, the producer emits at most one progress event per 3 seconds for that request, regardless of how often the underlying video API returns poll data.
- AE2. **Covers R7, R8.** When a producer emits a "rendering at 23s" event and then emits a "rendering at 33s" event for the same request, the on-disk state for that request reflects the 33s event; the older event is not retained.
- AE3. **Covers R9, R10.** When a user requests a video on a channel that supports update-in-place, they see exactly one message that updates through the lifecycle. When the same request flows through a channel without update-in-place, they see at most one message per stage transition and no per-tick updates.
- AE4. **Covers R13.** When the Veo API returns a quota error mid-render, the anchor message updates from its current in-progress rendering to a failure rendering that names the rendering stage and the producer-reported reason; no second message is posted.
- AE5. **Covers R14, R15.** When a producer goes silent for an in-flight request for longer than the watchdog threshold, the orchestrator overwrites that request's anchor with a stalled rendering naming the last-known stage, without any further input from the producer or the agent.
- AE6. **Covers R16.** When the orchestrator process restarts while a video request is in flight, the next progress event for that request after restart updates the original anchor message rather than posting a new one.

---

## Success Criteria

- The user never experiences > N seconds (threshold per F3) of silence between sending a video request and receiving either a progress update, the final video, or a failure notice — measured against the documented failure modes from the ideation grounding.
- A maintainer adding a new video producer (Omni, Sora, next) writes only the model-invocation script; they import the helper and call it; no IPC schema change, no orchestrator change, no channel change is required for the new producer to surface progress.
- The user-facing rendering matches the SBAR-style structured-slot format agreed in brainstorm so that planning does not need to re-decide UX shape.
- ce-plan can pick up this document and produce an implementable plan without inventing producer responsibilities, event semantics, failure dispatch model, or anchor durability — these are all locked here.

---

## Scope Boundaries

- Producers other than video-generation in v1 (image generation via `nano-banana-pro`, agent tool sequences, scheduled-task heartbeats). The schema must not preclude them, but no producer code ships for them now.
- Operator dashboard or structured operator log to disk. Events already live in IPC files; add a real consumer when one exists with a named use case.
- Model selection, provider switching, quality evaluation, fallback chains across video models. Separate concern, separate brainstorm.
- Reaction-based ack on the user's message (Idea 4 in the ideation). Alternative or layered addition, not bundled with this layer.
- Operation-aware first ack with cost/ETA/cancel (Idea 1 in the ideation). Complementary but separate brainstorm with its own product decisions.
- Inbound-video receipt at materialization (Idea 2 in the ideation). Adjacent and cheap, but separate brainstorm.
- Claude Agent SDK `includePartialMessages` tool-use narration (Idea 7 in the ideation). Becomes natural once this layer exists, but depends on it and ships later.

---

## Key Decisions

- **Producer-side throttling, not central.** Reason: rate-limit bleed is the documented failure (dblock.org Mar 2026 postmortem). One producer respecting one floor scales across producers and channels better than central coordination.
- **One edited anchor message per request, not separate ack + progress + final messages.** Reason: eliminates the documented Veo-returns-in-<2s race (failure mode #2 in grounding); halves rate-limit footprint; thread shows one request and one terminal message state.
- **Anchor handle persisted to the existing data store.** Reason: edit-in-place UX is load-bearing — an orchestrator restart mid-render that posts a new message instead of editing the original is a visible UX regression.
- **Failure path overwrites the anchor, does not post a separate message.** Reason: avoids orphaned in-progress messages; preserves the "one message per request" invariant from the prior decision.
- **Progress events persist on disk until terminal, not consume-and-delete.** Reason: the watchdog must be able to read freshness without racing the consumer. Diverges from the existing IPC pattern (messages/, tasks/, images/, videos/) for a specific reason — freshness inspection.
- **Watchdog fires through the existing failure-notice dispatcher, not a new path.** Reason: reuse the proven discriminated-union template; extend rather than duplicate.
- **Event schema generic across video providers.** Reason: model-agnostic v1 means swapping Veo for Omni / Sora must not require IPC schema changes — only a new producer script.

---

## Dependencies / Assumptions

- The existing IPC infrastructure — per-group directories under the data dir, JSON files, host-side poll-based watcher — remains the substrate. The new progress namespace lives alongside the existing `messages/`, `tasks/`, `images/`, `videos/` namespaces.
- The existing `routeFailureNotice` discriminated-union dispatcher pattern (router.ts) is the template the failure path extends; current `pre | mid | silent` failure kinds remain and a new kind is added for watchdog-detected stalls.
- The existing optional-channel-method convention (`setTyping?`, `sendImage?`, `sendVideo?` with deliberate no-op fallbacks where unsupported) is the template the new update-in-place method follows.
- The existing SQLite layer (`db.ts`) is reused for anchor handle persistence; no new data store is introduced.
- At least one channel (Slack) implements update-in-place at launch; other channels can add or remain on the append fallback without blocking the v1 ship.
- Slack `chat.update` has a documented 3-second floor; Telegram `editMessageText` and Discord `interaction.followup.edit` provide their own update-in-place primitives; WhatsApp Business and Gmail do not and use the append fallback.
- The default container timeout is 5 minutes; Veo polling cadence is ~10s. Both inform the default watchdog threshold but do not bind it.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] Should progress files use atomic write-and-rename for replace-in-place semantics, or another consistency mechanism given the poll-based host watcher? Planning should pick the simplest pattern that survives concurrent producer-emit and orchestrator-read.
- [Affects R12][Technical] What is the precise signature of the optional `Channel` update method, including the message-handle abstraction that works across channels with different native identifiers (Slack `ts`, Telegram `message_id`, Discord `id`)?
- [Affects R14][Needs research] What is the right default watchdog threshold based on observed Veo polling cadence, container timeout headroom, and channel typing TTLs? Should the threshold be model-specific or a single global value?
- [Affects R16][Technical] What is the right schema for the persisted anchor table (request ID, channel, native handle, created-at, last-update-at, terminal-state flag)?
- [Affects R10][Technical] On append-fallback channels, what is the right collapse rule when several stage transitions arrive faster than the channel's append cadence (e.g., the producer emits queued, rendering, and finalizing within 1 second)?
