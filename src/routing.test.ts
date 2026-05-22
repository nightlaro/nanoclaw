import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import {
  failureNoticeText,
  renderProgressEvent,
  routeFailureNotice,
  routeOutboundImage,
  routeOutboundVideo,
  routeProgressNotice,
} from './router.js';
import type { ProgressEvent } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- routeOutboundImage ---

describe('routeOutboundImage', () => {
  function makeChannel(
    owns: (j: string) => boolean,
    connected = true,
    withSendImage = true,
  ) {
    return {
      name: 'test',
      ownsJid: owns,
      isConnected: () => connected,
      sendMessage: vi.fn(async () => undefined),
      sendImage: withSendImage ? vi.fn(async () => undefined) : undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
    } as unknown as import('./types.js').Channel;
  }

  it('dispatches to channel.sendImage when defined', async () => {
    const ch = makeChannel((j) => j === 'slack:C1');
    await routeOutboundImage([ch], 'slack:C1', ['/abs/a.png'], 'hi');
    expect(ch.sendImage).toHaveBeenCalledWith('slack:C1', ['/abs/a.png'], 'hi');
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when channel lacks sendImage', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundImage([ch], 'wa:123', ['/abs/a.png'], 'caption');
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', 'caption');
  });

  it('falls back with [image] placeholder when no caption and no sendImage', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundImage([ch], 'wa:123', ['/abs/a.png']);
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', '[image]');
  });

  it('throws when no connected channel owns the jid', async () => {
    const ch = makeChannel(() => false);
    await expect(
      routeOutboundImage([ch], 'slack:C1', ['/abs/a.png']),
    ).rejects.toThrow(/No channel/);
  });
});

// --- routeOutboundVideo ---

describe('routeOutboundVideo', () => {
  function makeChannel(
    owns: (j: string) => boolean,
    connected = true,
    withSendVideo = true,
  ) {
    return {
      name: 'test',
      ownsJid: owns,
      isConnected: () => connected,
      sendMessage: vi.fn(async () => undefined),
      sendVideo: withSendVideo ? vi.fn(async () => undefined) : undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
    } as unknown as import('./types.js').Channel;
  }

  it('dispatches to channel.sendVideo when defined', async () => {
    const ch = makeChannel((j) => j === 'slack:C1');
    await routeOutboundVideo([ch], 'slack:C1', ['/abs/clip.mp4'], 'hi');
    expect(ch.sendVideo).toHaveBeenCalledWith(
      'slack:C1',
      ['/abs/clip.mp4'],
      'hi',
    );
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when channel lacks sendVideo', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundVideo([ch], 'wa:123', ['/abs/clip.mp4'], 'caption');
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', 'caption');
  });

  it('falls back with [video] placeholder when no caption and no sendVideo', async () => {
    const ch = makeChannel((j) => j === 'wa:123', true, false);
    await routeOutboundVideo([ch], 'wa:123', ['/abs/clip.mp4']);
    expect(ch.sendMessage).toHaveBeenCalledWith('wa:123', '[video]');
  });

  it('throws when no connected channel owns the jid', async () => {
    const ch = makeChannel(() => false);
    await expect(
      routeOutboundVideo([ch], 'slack:C1', ['/abs/clip.mp4']),
    ).rejects.toThrow(/No channel/);
  });
});

// --- failureNoticeText / routeFailureNotice ---

describe('failureNoticeText', () => {
  it('returns a pre-output apology mentioning a retry', () => {
    const text = failureNoticeText('pre');
    expect(text).toMatch(/⚠️/);
    expect(text.toLowerCase()).toMatch(/(try again|retry)/);
  });
  it('returns a mid-stream apology mentioning a retry', () => {
    const text = failureNoticeText('mid');
    expect(text).toMatch(/⚠️/);
    expect(text.toLowerCase()).toMatch(/(cut off|retry)/);
  });
  it('returns a silent-output apology mentioning rephrase or retry', () => {
    const text = failureNoticeText('silent');
    expect(text).toMatch(/⚠️/);
    expect(text.toLowerCase()).toMatch(/(rephras|try again|retry)/);
  });
  it('returns distinct copy for each kind', () => {
    const pre = failureNoticeText('pre');
    const mid = failureNoticeText('mid');
    const silent = failureNoticeText('silent');
    expect(new Set([pre, mid, silent]).size).toBe(3);
  });
});

describe('routeFailureNotice', () => {
  function makeChannel(owns: (j: string) => boolean, connected = true) {
    return {
      name: 'test',
      ownsJid: owns,
      isConnected: () => connected,
      sendMessage: vi.fn(async () => undefined),
      connect: async () => undefined,
      disconnect: async () => undefined,
    } as unknown as import('./types.js').Channel;
  }

  it('sends the failure notice via the owning channel', async () => {
    const ch = makeChannel((j) => j === 'slack:C1');
    await routeFailureNotice([ch], 'slack:C1', 'pre');
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'slack:C1',
      failureNoticeText('pre'),
    );
  });

  it('uses the mid-stream copy when kind is mid', async () => {
    const ch = makeChannel((j) => j === 'slack:C1');
    await routeFailureNotice([ch], 'slack:C1', 'mid');
    expect(ch.sendMessage).toHaveBeenCalledWith(
      'slack:C1',
      failureNoticeText('mid'),
    );
  });

  it('silently no-ops when no channel owns the jid', async () => {
    const ch = makeChannel(() => false);
    await expect(
      routeFailureNotice([ch], 'slack:C1', 'pre'),
    ).resolves.toBeUndefined();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('silently no-ops when the owning channel is disconnected', async () => {
    const ch = makeChannel((j) => j === 'slack:C1', false);
    await expect(
      routeFailureNotice([ch], 'slack:C1', 'pre'),
    ).resolves.toBeUndefined();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });
});

// --- renderProgressEvent ---

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    request_id: 'req-1',
    chat_jid: 'slack:C1',
    kind: 'tick',
    stage: 'rendering',
    elapsed_sec: 23,
    emitted_at: '2026-05-21T00:00:23.000Z',
    ...overrides,
  };
}

describe('renderProgressEvent', () => {
  it('renders started/tick/stage with SBAR header + stage + elapsed', () => {
    const text = renderProgressEvent(event({ kind: 'tick' }));
    expect(text).toContain('🎬 Video render');
    expect(text).toContain('Stage:');
    expect(text).toContain('rendering');
    expect(text).toContain('Elapsed:');
    expect(text).toContain('23s');
  });

  it('includes ETA / Percent / Next when present', () => {
    const text = renderProgressEvent(
      event({
        kind: 'tick',
        eta_sec: 37,
        percent: 42,
        next_stage: 'finalizing',
      }),
    );
    expect(text).toContain('ETA:');
    expect(text).toContain('~37s');
    expect(text).toContain('Percent:');
    expect(text).toContain('42%');
    expect(text).toContain('Next:');
    expect(text).toContain('finalizing');
  });

  it('omits ETA / Percent / Next when absent', () => {
    const text = renderProgressEvent(event({ kind: 'tick' }));
    expect(text).not.toContain('ETA:');
    expect(text).not.toContain('Percent:');
    expect(text).not.toContain('Next:');
  });

  it('renders done with completion header', () => {
    const text = renderProgressEvent(
      event({ kind: 'done', stage: 'uploading', elapsed_sec: 60 }),
    );
    expect(text).toContain('✅');
    expect(text).toContain('complete');
    expect(text).toContain('uploading');
    expect(text).toContain('1m'); // 60s formats as 1m
  });

  it('renders failed with reason when provided', () => {
    const text = renderProgressEvent(
      event({
        kind: 'failed',
        stage: 'rendering',
        reason: 'quota exhausted',
      }),
    );
    expect(text).toContain('⚠️');
    expect(text).toContain('failed');
    expect(text).toContain('rendering');
    expect(text).toContain('Reason:');
    expect(text).toContain('quota exhausted');
  });

  it('formats elapsed_sec under 60s in seconds', () => {
    expect(renderProgressEvent(event({ elapsed_sec: 0 }))).toContain('0s');
    expect(renderProgressEvent(event({ elapsed_sec: 45 }))).toContain('45s');
  });

  it('formats elapsed_sec >= 60s in minutes (with seconds when nonzero)', () => {
    expect(renderProgressEvent(event({ elapsed_sec: 60 }))).toContain('1m');
    expect(renderProgressEvent(event({ elapsed_sec: 90 }))).toContain('1m30s');
    expect(renderProgressEvent(event({ elapsed_sec: 125 }))).toContain('2m5s');
  });
});

// --- routeProgressNotice ---

describe('routeProgressNotice', () => {
  function makeChannel(opts: {
    owns?: (jid: string) => boolean;
    connected?: boolean;
    withUpdateMessage?: boolean;
    sendReturns?: string | undefined;
  }) {
    const sendMessage = vi.fn(async () => opts.sendReturns);
    const updateMessage = vi.fn(async () => undefined);
    return {
      channel: {
        name: 'test',
        ownsJid: opts.owns ?? ((j: string) => j === 'slack:C1'),
        isConnected: () => opts.connected !== false,
        sendMessage,
        updateMessage: opts.withUpdateMessage ? updateMessage : undefined,
        connect: async () => undefined,
        disconnect: async () => undefined,
      } as unknown as import('./types.js').Channel,
      sendMessage,
      updateMessage,
    };
  }

  it('edits in place when handle present and channel supports update', async () => {
    const { channel, updateMessage, sendMessage } = makeChannel({
      withUpdateMessage: true,
    });
    const handle = 'C1:1700000000.000001';

    const result = await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'tick', elapsed_sec: 23 }),
      handle,
    );

    expect(updateMessage).toHaveBeenCalledWith(
      'slack:C1',
      handle,
      expect.stringContaining('Elapsed: 23s'),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('sends new message and returns handle when no anchor yet', async () => {
    const { channel, sendMessage, updateMessage } = makeChannel({
      withUpdateMessage: true,
      sendReturns: 'C1:1700000001.000002',
    });

    const result = await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'started' }),
      undefined,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(result).toBe('C1:1700000001.000002');
  });

  it('suppresses tick events on channels without updateMessage (append-fallback)', async () => {
    const { channel, sendMessage } = makeChannel({
      withUpdateMessage: false,
    });

    const result = await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'tick' }),
      undefined,
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('emits stage transitions on append-fallback channels', async () => {
    const { channel, sendMessage } = makeChannel({
      withUpdateMessage: false,
      sendReturns: undefined,
    });

    await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'stage', stage: 'finalizing' }),
      undefined,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:C1',
      expect.stringContaining('finalizing'),
    );
  });

  it('emits terminal events on append-fallback channels', async () => {
    const { channel, sendMessage } = makeChannel({
      withUpdateMessage: false,
    });

    await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'done', stage: 'uploading', elapsed_sec: 60 }),
      undefined,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:C1',
      expect.stringContaining('complete'),
    );
  });

  it('silently no-ops when no channel owns the JID', async () => {
    const { channel, sendMessage, updateMessage } = makeChannel({
      owns: () => false,
      withUpdateMessage: true,
    });

    const result = await routeProgressNotice(
      [channel],
      'slack:DOESNOTEXIST',
      event({ kind: 'tick' }),
      'C1:1.0',
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('silently no-ops when the owning channel is disconnected', async () => {
    const { channel, sendMessage } = makeChannel({
      connected: false,
      withUpdateMessage: true,
    });

    await routeProgressNotice(
      [channel],
      'slack:C1',
      event({ kind: 'started' }),
      undefined,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when updateMessage rejects', async () => {
    const { channel, updateMessage } = makeChannel({
      withUpdateMessage: true,
    });
    (updateMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('chat_update_failed'),
    );

    await expect(
      routeProgressNotice(
        [channel],
        'slack:C1',
        event({ kind: 'tick' }),
        'C1:1.0',
      ),
    ).resolves.toBeUndefined();
  });

  it('does not throw when sendMessage rejects', async () => {
    const { channel, sendMessage } = makeChannel({
      withUpdateMessage: true,
    });
    (sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('postMessage_failed'),
    );

    await expect(
      routeProgressNotice(
        [channel],
        'slack:C1',
        event({ kind: 'started' }),
        undefined,
      ),
    ).resolves.toBeUndefined();
  });
});
