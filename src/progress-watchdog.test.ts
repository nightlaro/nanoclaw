import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ProgressAnchor } from './db.js';
import {
  _resetProgressWatchdogForTests,
  startProgressWatchdog,
  stopProgressWatchdog,
} from './progress-watchdog.js';

function anchor(overrides: Partial<ProgressAnchor> = {}): ProgressAnchor {
  return {
    request_id: 'req-1',
    chat_jid: 'slack:C1',
    channel: 'slack',
    handle: 'C1:1.0',
    last_stage: 'rendering',
    model_id: 'veo-3.1',
    created_at: '2026-05-21T00:00:00.000Z',
    last_update_at: '2026-05-21T00:00:00.000Z',
    last_processed_emitted_at: '2026-05-21T00:00:00.000Z',
    terminal_state: null,
    ...overrides,
  };
}

describe('progress watchdog', () => {
  beforeEach(() => {
    _resetProgressWatchdogForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T01:00:00.000Z'));
  });

  afterEach(() => {
    stopProgressWatchdog();
    vi.useRealTimers();
  });

  it('does not query for stale anchors during the boot grace window', async () => {
    const getStale = vi.fn(() => [anchor()]);
    const markTerminal = vi.fn();
    const routeFailureNotice = vi.fn(async () => undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: markTerminal,
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    // First tick (30s after boot) — still inside the 90s grace window
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getStale).not.toHaveBeenCalled();

    // Second tick (60s after boot) — still inside grace
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getStale).not.toHaveBeenCalled();
  });

  it('fires stalled notice for stale anchors after the boot grace passes', async () => {
    const staleAnchor = anchor({
      request_id: 'req-old',
      last_update_at: '2026-05-21T00:58:00.000Z', // 2min before now (1h offset)
      last_stage: 'rendering',
    });
    const getStale = vi.fn(() => [staleAnchor]);
    const markTerminal = vi.fn();
    const routeFailureNotice = vi.fn(async () => undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: markTerminal,
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    // Advance past the boot grace window (90s + buffer)
    await vi.advanceTimersByTimeAsync(90_000);

    expect(getStale).toHaveBeenCalled();
    expect(routeFailureNotice).toHaveBeenCalledWith('slack:C1', 'stalled', {
      anchorHandle: 'C1:1.0',
      lastStage: 'rendering',
    });
    expect(markTerminal).toHaveBeenCalledWith(
      'req-old',
      'stalled',
      'rendering',
    );
  });

  it('passes ISO threshold (now - thresholdMs) to getActiveAnchorsStaleBefore', async () => {
    const getStale = vi.fn<
      (thresholdIso: string) => ProgressAnchor[]
    >(() => []);
    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: vi.fn(),
        routeFailureNotice: vi.fn(async () => undefined),
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    // Advance past boot grace
    await vi.advanceTimersByTimeAsync(90_000);

    expect(getStale).toHaveBeenCalled();
    const arg = getStale.mock.calls[0][0];
    // First fire is at t=90s (tick 3, first one past the 90s boot grace).
    // now = 01:00:00 + 90s = 01:01:30; cutoff = now - 90s = 01:00:00.000Z
    expect(arg).toBe('2026-05-21T01:00:00.000Z');
  });

  it('marks every stale anchor even if one routeFailureNotice rejects', async () => {
    const a1 = anchor({ request_id: 'req-1', chat_jid: 'slack:C1' });
    const a2 = anchor({ request_id: 'req-2', chat_jid: 'slack:C2' });
    const a3 = anchor({ request_id: 'req-3', chat_jid: 'slack:C3' });

    const getStale = vi.fn(() => [a1, a2, a3]);
    const markTerminal = vi.fn();
    const routeFailureNotice = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('chat_update_failed'))
      .mockResolvedValueOnce(undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: markTerminal,
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    await vi.advanceTimersByTimeAsync(90_000);

    // routeFailureNotice attempted on all three; markTerminal called for the
    // two that succeeded (the one whose dispatch rejected is logged but
    // intentionally NOT marked terminal so the next tick retries).
    expect(routeFailureNotice).toHaveBeenCalledTimes(3);
    expect(markTerminal).toHaveBeenCalledTimes(2);
    expect(markTerminal).toHaveBeenCalledWith('req-1', 'stalled', 'rendering');
    expect(markTerminal).toHaveBeenCalledWith('req-3', 'stalled', 'rendering');
  });

  it('passes undefined lastStage when anchor.last_stage is null', async () => {
    const stale = anchor({ last_stage: null });
    const getStale = vi.fn(() => [stale]);
    const routeFailureNotice = vi.fn(async () => undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: vi.fn(),
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    await vi.advanceTimersByTimeAsync(90_000);

    expect(routeFailureNotice).toHaveBeenCalledWith('slack:C1', 'stalled', {
      anchorHandle: 'C1:1.0',
      lastStage: undefined,
    });
  });

  it('does nothing when no stale anchors exist', async () => {
    const getStale = vi.fn(() => []);
    const markTerminal = vi.fn();
    const routeFailureNotice = vi.fn(async () => undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: markTerminal,
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    await vi.advanceTimersByTimeAsync(90_000);

    expect(getStale).toHaveBeenCalled(); // query ran
    expect(routeFailureNotice).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it('survives getActiveAnchorsStaleBefore throwing (logged, next tick continues)', async () => {
    const getStale = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('db_unavailable');
      })
      .mockReturnValueOnce([]);
    const markTerminal = vi.fn();
    const routeFailureNotice = vi.fn(async () => undefined);

    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: markTerminal,
        routeFailureNotice,
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    // Two ticks past boot grace: t=90s (throws) then t=120s (returns [])
    await vi.advanceTimersByTimeAsync(120_000);

    expect(getStale).toHaveBeenCalledTimes(2);
    expect(routeFailureNotice).not.toHaveBeenCalled();
  });

  it('startProgressWatchdog is idempotent — second call does not spawn another timer', async () => {
    const getStale = vi.fn(() => []);
    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: vi.fn(),
        routeFailureNotice: vi.fn(async () => undefined),
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );
    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: vi.fn(),
        routeFailureNotice: vi.fn(async () => undefined),
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    await vi.advanceTimersByTimeAsync(90_000);

    // Single tick fired past grace (only one timer is running)
    expect(getStale).toHaveBeenCalledTimes(1);
  });

  it('stopProgressWatchdog halts future ticks', async () => {
    const getStale = vi.fn(() => []);
    startProgressWatchdog(
      {
        getActiveAnchorsStaleBefore: getStale,
        markAnchorTerminal: vi.fn(),
        routeFailureNotice: vi.fn(async () => undefined),
      },
      { tickMs: 30_000, thresholdMs: 90_000 },
    );

    // Past boot grace
    await vi.advanceTimersByTimeAsync(90_000);
    expect(getStale).toHaveBeenCalledTimes(1);

    stopProgressWatchdog();

    // Further ticks should not fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getStale).toHaveBeenCalledTimes(1);
  });
});
