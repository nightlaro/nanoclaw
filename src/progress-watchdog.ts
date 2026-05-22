/**
 * Progress watchdog — scans `progress_anchors` for in-flight anchors that
 * have stopped emitting events past the configured threshold and dispatches
 * `routeFailureNotice(..., 'stalled')` so the user never experiences silent
 * abandonment when the container is killed mid-render (R14, R15).
 *
 * Boot-time grace: anchors whose `last_update_at` predates the orchestrator's
 * startup are not marked stalled until (now - startup_time) > thresholdMs.
 * A restart during a healthy 2-minute render must not fire a spurious stall;
 * the watchdog waits for the threshold window to elapse since boot before
 * any of those anchors can be considered stale.
 */

import { ProgressAnchor } from './db.js';
import { logger } from './logger.js';
import { FailureNoticeContext } from './router.js';

export interface ProgressWatchdogDeps {
  getActiveAnchorsStaleBefore: (thresholdIso: string) => ProgressAnchor[];
  markAnchorTerminal: (
    requestId: string,
    state: 'completed' | 'failed' | 'stalled' | 'anchor_lost',
    lastStage?: string,
  ) => void;
  routeFailureNotice: (
    jid: string,
    kind: 'stalled',
    ctx: FailureNoticeContext,
  ) => Promise<void>;
}

export interface ProgressWatchdogOptions {
  tickMs?: number;
  thresholdMs?: number;
  // Injection points for deterministic timing in tests. Production code
  // uses Date.now and the real setInterval / clearInterval.
  nowMs?: () => number;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_THRESHOLD_MS = 90_000;

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let startupTime = 0;

export function startProgressWatchdog(
  deps: ProgressWatchdogDeps,
  opts: ProgressWatchdogOptions = {},
): void {
  if (watchdogTimer !== null) return;

  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const envThreshold = Number(process.env.PROGRESS_WATCHDOG_THRESHOLD_MS);
  const thresholdMs =
    opts.thresholdMs ??
    (Number.isFinite(envThreshold) && envThreshold > 0
      ? envThreshold
      : DEFAULT_THRESHOLD_MS);
  const now = opts.nowMs ?? (() => Date.now());

  startupTime = now();

  const tick = async () => {
    const currentNow = now();

    // Boot grace: an orchestrator that just came back up shouldn't mark
    // anchors stalled simply because they were last touched before the
    // restart — the producer in the container is likely still alive.
    if (currentNow - startupTime < thresholdMs) {
      return;
    }

    const cutoffIso = new Date(currentNow - thresholdMs).toISOString();
    let staleAnchors: ProgressAnchor[];
    try {
      staleAnchors = deps.getActiveAnchorsStaleBefore(cutoffIso);
    } catch (err) {
      logger.error(
        { err },
        'Progress watchdog: getActiveAnchorsStaleBefore failed',
      );
      return;
    }

    for (const anchor of staleAnchors) {
      try {
        await deps.routeFailureNotice(anchor.chat_jid, 'stalled', {
          anchorHandle: anchor.handle,
          lastStage: anchor.last_stage ?? undefined,
        });
        deps.markAnchorTerminal(
          anchor.request_id,
          'stalled',
          anchor.last_stage ?? undefined,
        );
        logger.info(
          {
            requestId: anchor.request_id,
            chatJid: anchor.chat_jid,
            lastStage: anchor.last_stage,
          },
          'Progress watchdog: anchor marked stalled',
        );
      } catch (err) {
        // One anchor's failure must not block dispatch for the rest —
        // mirrors the catch shape at src/index.ts:369-377.
        logger.error(
          { requestId: anchor.request_id, err },
          'Progress watchdog: failed to dispatch stalled notice',
        );
      }
    }
  };

  watchdogTimer = setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, 'Progress watchdog tick crashed');
    });
  }, tickMs);

  logger.info(
    { tickMs, thresholdMs },
    'Progress watchdog started',
  );
}

export function stopProgressWatchdog(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** @internal — test-only reset between cases. */
export function _resetProgressWatchdogForTests(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  startupTime = 0;
}
