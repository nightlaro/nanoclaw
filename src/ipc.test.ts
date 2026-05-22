import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  processImageIpcFile,
  processProgressIpcFile,
  ProgressIpcAccessors,
} from './ipc.js';
import { ProgressAnchor } from './db.js';
import { processVideoIpcFile } from './ipc.js';
import { ProgressEvent, RegisteredGroup, MessageHandle } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: '@E',
  added_at: '',
  isMain: true,
};

const SLACK_TEST: RegisteredGroup = {
  name: 'Test',
  folder: 'slack_test',
  trigger: '@E',
  added_at: '',
};

describe('processImageIpcFile', () => {
  let tmpDir: string;
  let groupsDir: string;
  let sendImage: ReturnType<
    typeof vi.fn<
      (jid: string, paths: string[], caption?: string) => Promise<void>
    >
  >;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-img-'));
    groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'slack_test', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_other', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_main', 'outbox'), {
      recursive: true,
    });
    sendImage = vi.fn(async () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registered() {
    return {
      'slack:C1': SLACK_TEST,
      'slack:Cmain': MAIN_GROUP,
    };
  }

  it('dispatches sendImage for a valid authorized image IPC payload', async () => {
    const imgPath = path.join(groupsDir, 'slack_test', 'outbox', 'a.png');
    fs.writeFileSync(imgPath, 'PNGDATA');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/a.png'],
        caption: 'hello',
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [imgPath], 'hello');
  });

  it('rejects path traversal (../../etc/passwd)', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['../../etc/passwd'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('blocks cross-group sends for non-main groups', async () => {
    const imgPath = path.join(groupsDir, 'slack_other', 'outbox', 'x.png');
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test
        groupFolder: 'slack_other',
        paths: ['outbox/x.png'],
      },
      'slack_other',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('allows main group to send to any jid', async () => {
    const imgPath = path.join(groupsDir, 'slack_main', 'outbox', 'x.png');
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test, but main is sending
        groupFolder: 'slack_main',
        paths: ['outbox/x.png'],
      },
      'slack_main',
      true, // isMain
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [imgPath], undefined);
  });

  it('skips missing files but delivers surviving ones', async () => {
    const goodPath = path.join(groupsDir, 'slack_test', 'outbox', 'ok.png');
    fs.writeFileSync(goodPath, 'OK');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing.png', 'outbox/ok.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [goodPath], undefined);
  });

  it('does not call sendImage when all paths are missing', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing1.png', 'outbox/missing2.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('ignores payloads with missing required fields', async () => {
    await processImageIpcFile(
      { type: 'image' } as unknown as Parameters<typeof processImageIpcFile>[0],
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });
});

describe('processVideoIpcFile', () => {
  let tmpDir: string;
  let groupsDir: string;
  let sendVideo: ReturnType<
    typeof vi.fn<
      (jid: string, paths: string[], caption?: string) => Promise<void>
    >
  >;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-vid-'));
    groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'slack_test', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_other', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_main', 'outbox'), {
      recursive: true,
    });
    sendVideo = vi.fn(async () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registered() {
    return {
      'slack:C1': SLACK_TEST,
      'slack:Cmain': MAIN_GROUP,
    };
  }

  it('dispatches sendVideo for a valid authorized video IPC payload', async () => {
    const vidPath = path.join(groupsDir, 'slack_test', 'outbox', 'a.mp4');
    fs.writeFileSync(vidPath, 'MP4DATA');

    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/a.mp4'],
        caption: 'hello',
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).toHaveBeenCalledWith('slack:C1', [vidPath], 'hello');
  });

  it('rejects non-mp4 paths', async () => {
    const movPath = path.join(groupsDir, 'slack_test', 'outbox', 'a.mov');
    fs.writeFileSync(movPath, 'MOVDATA');

    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/a.mov'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('rejects path traversal', async () => {
    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['../../etc/passwd.mp4'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('blocks cross-group sends for non-main groups', async () => {
    const vidPath = path.join(groupsDir, 'slack_other', 'outbox', 'x.mp4');
    fs.writeFileSync(vidPath, 'X');

    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_other',
        paths: ['outbox/x.mp4'],
      },
      'slack_other',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('allows main group to send to any jid', async () => {
    const vidPath = path.join(groupsDir, 'slack_main', 'outbox', 'x.mp4');
    fs.writeFileSync(vidPath, 'X');

    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_main',
        paths: ['outbox/x.mp4'],
      },
      'slack_main',
      true,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).toHaveBeenCalledWith('slack:C1', [vidPath], undefined);
  });

  it('skips missing files but delivers surviving ones', async () => {
    const goodPath = path.join(groupsDir, 'slack_test', 'outbox', 'ok.mp4');
    fs.writeFileSync(goodPath, 'OK');

    await processVideoIpcFile(
      {
        type: 'video',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing.mp4', 'outbox/ok.mp4'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).toHaveBeenCalledWith('slack:C1', [goodPath], undefined);
  });

  it('ignores payloads with missing required fields', async () => {
    await processVideoIpcFile(
      { type: 'video' } as unknown as Parameters<typeof processVideoIpcFile>[0],
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('ignores payloads with wrong type', async () => {
    await processVideoIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        paths: ['outbox/a.mp4'],
      } as unknown as Parameters<typeof processVideoIpcFile>[0],
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendVideo,
    );

    expect(sendVideo).not.toHaveBeenCalled();
  });
});

// --- processProgressIpcFile ---

describe('processProgressIpcFile', () => {
  let getAnchor: ReturnType<
    typeof vi.fn<(requestId: string) => ProgressAnchor | undefined>
  >;
  let upsertAnchor: ProgressIpcAccessors['upsertAnchor'] & {
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  let markTerminal: ProgressIpcAccessors['markTerminal'] & {
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  let updateLastProcessed: ProgressIpcAccessors['updateLastProcessed'] & {
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  let routeProgress: ((
    jid: string,
    event: ProgressEvent,
    handle: MessageHandle | undefined,
  ) => Promise<MessageHandle | undefined>) & {
    mock: ReturnType<typeof vi.fn>['mock'];
    mockResolvedValueOnce: (value: MessageHandle | undefined) => unknown;
  };

  beforeEach(() => {
    getAnchor = vi.fn(() => undefined);
    upsertAnchor = vi.fn() as unknown as typeof upsertAnchor;
    markTerminal = vi.fn() as unknown as typeof markTerminal;
    updateLastProcessed = vi.fn() as unknown as typeof updateLastProcessed;
    routeProgress = vi.fn(
      async () => undefined,
    ) as unknown as typeof routeProgress;
  });

  function accessors(): ProgressIpcAccessors {
    return {
      getAnchor,
      upsertAnchor,
      markTerminal,
      updateLastProcessed,
    };
  }

  function registered() {
    return {
      'slack:C1': SLACK_TEST,
      'slack:Cmain': MAIN_GROUP,
    };
  }

  function ev(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
    return {
      request_id: 'req-1',
      chat_jid: 'slack:C1',
      kind: 'started',
      stage: 'queued',
      elapsed_sec: 0,
      emitted_at: '2026-05-21T00:00:00.000Z',
      ...overrides,
    };
  }

  function anchorRow(overrides: Partial<ProgressAnchor> = {}): ProgressAnchor {
    return {
      request_id: 'req-1',
      chat_jid: 'slack:C1',
      channel: 'slack',
      handle: 'C1:1.0',
      last_stage: 'queued',
      model_id: 'veo-3.1',
      created_at: '2026-05-21T00:00:00.000Z',
      last_update_at: '2026-05-21T00:00:00.000Z',
      last_processed_emitted_at: '2026-05-21T00:00:00.000Z',
      terminal_state: null,
      ...overrides,
    };
  }

  it('on fresh started event posts initial anchor and upserts with handle', async () => {
    routeProgress.mockResolvedValueOnce('C1:1700000000.000001');

    const result = await processProgressIpcFile(
      ev({ kind: 'started' }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalledWith(
      'slack:C1',
      expect.objectContaining({ kind: 'started' }),
      undefined,
    );
    expect(upsertAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req-1',
        chat_jid: 'slack:C1',
        handle: 'C1:1700000000.000001',
        last_stage: 'queued',
        model_id: null,
        channel: 'slack',
      }),
    );
    expect(updateLastProcessed).toHaveBeenCalledWith(
      'req-1',
      '2026-05-21T00:00:00.000Z',
      expect.any(String),
      'queued',
    );
    expect(markTerminal).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('on tick when anchor exists, calls routeProgress with stored handle', async () => {
    getAnchor.mockReturnValueOnce(anchorRow());

    const result = await processProgressIpcFile(
      ev({
        kind: 'tick',
        stage: 'rendering',
        elapsed_sec: 10,
        emitted_at: '2026-05-21T00:00:10.000Z',
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalledWith(
      'slack:C1',
      expect.objectContaining({ kind: 'tick' }),
      'C1:1.0',
    );
    expect(updateLastProcessed).toHaveBeenCalledWith(
      'req-1',
      '2026-05-21T00:00:10.000Z',
      expect.any(String),
      'rendering',
    );
    expect(markTerminal).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('on terminal done marks terminal=completed and signals unlink', async () => {
    getAnchor.mockReturnValueOnce(anchorRow());

    const result = await processProgressIpcFile(
      ev({
        kind: 'done',
        stage: 'uploading',
        elapsed_sec: 60,
        media_path: '/workspace/group/outbox/out.mp4',
        emitted_at: '2026-05-21T00:01:00.000Z',
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalledWith(
      'slack:C1',
      expect.objectContaining({ kind: 'done' }),
      'C1:1.0',
    );
    expect(markTerminal).toHaveBeenCalledWith('req-1', 'completed', 'uploading');
    expect(result.shouldUnlink).toBe(true);
  });

  it('on terminal failed marks terminal=failed with reason in event', async () => {
    getAnchor.mockReturnValueOnce(anchorRow());

    const result = await processProgressIpcFile(
      ev({
        kind: 'failed',
        stage: 'rendering',
        elapsed_sec: 20,
        reason: 'quota exhausted',
        emitted_at: '2026-05-21T00:00:20.000Z',
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(markTerminal).toHaveBeenCalledWith('req-1', 'failed', 'rendering');
    expect(result.shouldUnlink).toBe(true);
  });

  it('stale leftover: anchor already terminal, file should be unlinked silently', async () => {
    getAnchor.mockReturnValueOnce(
      anchorRow({ terminal_state: 'completed' }),
    );

    const result = await processProgressIpcFile(
      ev({ kind: 'started' }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
    expect(updateLastProcessed).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(true);
  });

  it('event-sequence dedup: emitted_at <= last_processed_emitted_at is a no-op', async () => {
    getAnchor.mockReturnValueOnce(
      anchorRow({ last_processed_emitted_at: '2026-05-21T00:00:10.000Z' }),
    );

    const result = await processProgressIpcFile(
      ev({
        kind: 'tick',
        elapsed_sec: 10,
        emitted_at: '2026-05-21T00:00:10.000Z', // equal — already processed
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).not.toHaveBeenCalled();
    expect(updateLastProcessed).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('event-sequence dedup: strictly newer emitted_at processes normally', async () => {
    getAnchor.mockReturnValueOnce(
      anchorRow({ last_processed_emitted_at: '2026-05-21T00:00:10.000Z' }),
    );

    const result = await processProgressIpcFile(
      ev({
        kind: 'tick',
        elapsed_sec: 11,
        emitted_at: '2026-05-21T00:00:11.000Z',
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalled();
    expect(updateLastProcessed).toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('authorization: blocks cross-group send for non-main groups', async () => {
    const result = await processProgressIpcFile(
      ev(), // chat_jid 'slack:C1' belongs to SLACK_TEST
      'slack_other', // different sourceGroup
      false, // not main
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).not.toHaveBeenCalled();
    expect(upsertAnchor).not.toHaveBeenCalled();
    // File is kept for diagnostic, not unlinked
    expect(result.shouldUnlink).toBe(false);
  });

  it('authorization: main group can route to any jid', async () => {
    routeProgress.mockResolvedValueOnce('C1:1.x');
    const result = await processProgressIpcFile(
      ev({ kind: 'started' }),
      'slack_main',
      true, // isMain
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalled();
    expect(upsertAnchor).toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('malformed payload: missing request_id is skipped (file kept for diagnostic)', async () => {
    const result = await processProgressIpcFile(
      {
        chat_jid: 'slack:C1',
        kind: 'started',
        stage: 'queued',
        elapsed_sec: 0,
        emitted_at: '2026-05-21T00:00:00.000Z',
      } as unknown as ProgressEvent,
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('malformed payload: missing chat_jid is skipped', async () => {
    const result = await processProgressIpcFile(
      {
        request_id: 'req-1',
        kind: 'started',
        stage: 'queued',
        elapsed_sec: 0,
        emitted_at: '2026-05-21T00:00:00.000Z',
      } as unknown as ProgressEvent,
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).not.toHaveBeenCalled();
    expect(result.shouldUnlink).toBe(false);
  });

  it('no handle returned for fresh started event: still tracks dedup cursor', async () => {
    // Channel without updateMessage capability returns undefined from
    // routeProgressNotice. The consumer can't track anchor edits, but
    // should still respect dedup so the same file isn't re-dispatched.
    routeProgress.mockResolvedValueOnce(undefined);

    const result = await processProgressIpcFile(
      ev({ kind: 'started' }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalled();
    expect(upsertAnchor).not.toHaveBeenCalled(); // no handle → no anchor
    expect(result.shouldUnlink).toBe(false);
  });

  it('terminal kind without prior anchor still unlinks the file', async () => {
    // Rare race: terminal arrives without a prior started (e.g. orchestrator
    // restarted between started and done). routeProgress is invoked so the
    // user still sees the terminal render; the file is unlinked.
    const result = await processProgressIpcFile(
      ev({
        kind: 'done',
        stage: 'uploading',
        elapsed_sec: 60,
        emitted_at: '2026-05-21T00:01:00.000Z',
      }),
      'slack_test',
      false,
      registered(),
      accessors(),
      routeProgress,
    );

    expect(routeProgress).toHaveBeenCalledWith(
      'slack:C1',
      expect.objectContaining({ kind: 'done' }),
      undefined,
    );
    expect(result.shouldUnlink).toBe(true);
  });
});
