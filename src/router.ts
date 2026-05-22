import { logger } from './logger.js';
import { Channel, MessageHandle, NewMessage, ProgressEvent } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  // Discard any MessageHandle returned. Callers that need the handle (e.g.
  // the progress consumer at the 'started' event) call channel.sendMessage
  // directly via findChannel rather than routing through this helper.
  await channel.sendMessage(jid, text);
}

export async function routeOutboundImage(
  channels: Channel[],
  jid: string,
  imagePaths: string[],
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (channel.sendImage) {
    await channel.sendImage(jid, imagePaths, caption);
    return;
  }
  // Graceful fallback: surface the agent's caption (or a placeholder) as text.
  await channel.sendMessage(jid, caption ?? '[image]');
}

export async function routeOutboundVideo(
  channels: Channel[],
  jid: string,
  videoPaths: string[],
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (channel.sendVideo) {
    await channel.sendVideo(jid, videoPaths, caption);
    return;
  }
  // Graceful fallback: surface the agent's caption (or a placeholder) as text.
  await channel.sendMessage(jid, caption ?? '[video]');
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

// User-facing apology messages for the three silent-failure modes the
// orchestrator can detect when running an agent turn.
//
// - 'pre'    : the agent errored before streaming any output to the user.
//              They saw "Got it, working on it..." and then silence.
// - 'mid'    : the agent streamed something useful, then errored. They saw
//              partial output and the rest never landed.
// - 'silent' : the agent reported success but never emitted any text. They
//              saw "Got it, working on it..." and then a graceful return
//              with no follow-up — indistinguishable from a hang.
//
// The orchestrator dispatches via this lookup so the failure pathway
// stays out of the per-channel handlers and is unit-testable in isolation.
export type FailureKind = 'pre' | 'mid' | 'silent';

const FAILURE_COPY: Record<FailureKind, string> = {
  pre: '⚠️ Something broke on my end before I could finish. Try again?',
  mid: '⚠️ Got cut off mid-reply. Want me to retry?',
  silent:
    "⚠️ I'm here, but nothing useful came back from that run. Mind rephrasing or trying again?",
};

export function failureNoticeText(kind: FailureKind): string {
  return FAILURE_COPY[kind];
}

export async function routeFailureNotice(
  channels: Channel[],
  jid: string,
  kind: FailureKind,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  // Swallow when the channel is unreachable — the failure notice is a
  // best-effort overlay on top of an already-failed turn. Logging is the
  // caller's responsibility so the error path stays narrow here.
  if (!channel) return;
  await channel.sendMessage(jid, failureNoticeText(kind));
}

// --- Progress feedback routing (video-progress layer) ---

/**
 * Format a producer-emitted ProgressEvent into an SBAR-style slot block.
 * Stable scannable layout the user can parse at a glance:
 *
 *   🎬 Video render
 *   Stage:   rendering
 *   Elapsed: 23s
 *   ETA:     ~37s
 *   Next:    finalizing
 *
 * Terminal kinds use distinct icons; failure includes the producer reason.
 */
export function renderProgressEvent(event: ProgressEvent): string {
  const elapsed = formatElapsedSec(event.elapsed_sec);
  const lines: string[] = [];

  switch (event.kind) {
    case 'started':
    case 'tick':
    case 'stage':
      lines.push('🎬 Video render');
      lines.push(`Stage:   ${event.stage}`);
      lines.push(`Elapsed: ${elapsed}`);
      if (event.eta_sec !== undefined) {
        lines.push(`ETA:     ~${formatElapsedSec(event.eta_sec)}`);
      }
      if (event.percent !== undefined) {
        lines.push(`Percent: ${Math.round(event.percent)}%`);
      }
      if (event.next_stage) {
        lines.push(`Next:    ${event.next_stage}`);
      }
      break;
    case 'done':
      lines.push('✅ Video render complete');
      lines.push(`Stage:   ${event.stage}`);
      lines.push(`Elapsed: ${elapsed}`);
      break;
    case 'failed':
      lines.push('⚠️ Video render failed');
      lines.push(`Stage:   ${event.stage}`);
      if (event.reason) {
        lines.push(`Reason:  ${event.reason}`);
      }
      break;
  }

  return lines.join('\n');
}

function formatElapsedSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * Channel-agnostic dispatcher for progress events. Mirrors routeFailureNotice:
 * silent when no channel owns the JID, never throws. Edit-in-place via
 * Channel.updateMessage? when a handle is present and the channel supports it;
 * otherwise falls back to sendMessage and suppresses intra-stage ticks (R10).
 *
 * Critically does NOT go through deduplicatedSend: the 5s/200-char window
 * in src/index.ts would silently drop progress updates that hash identically.
 */
export async function routeProgressNotice(
  channels: Channel[],
  jid: string,
  event: ProgressEvent,
  anchorHandle: MessageHandle | undefined,
): Promise<MessageHandle | undefined> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) {
    logger.warn(
      { jid, kind: event.kind },
      'No connected channel owns JID for progress event, skipping',
    );
    return undefined;
  }

  const text = renderProgressEvent(event);

  // Edit-in-place path: anchor present AND channel implements updateMessage.
  if (anchorHandle && channel.updateMessage) {
    try {
      await channel.updateMessage(jid, anchorHandle, text);
    } catch (err) {
      logger.warn(
        { jid, kind: event.kind, err },
        'Progress updateMessage failed',
      );
    }
    return undefined;
  }

  // Append-fallback for handle-less / non-edit channels (R10): only emit on
  // stage transitions, started, and terminal events. Suppress 'tick' so the
  // channel isn't flooded with per-poll updates.
  if (event.kind === 'tick') {
    return undefined;
  }

  try {
    return await channel.sendMessage(jid, text);
  } catch (err) {
    logger.warn({ jid, kind: event.kind, err }, 'Progress sendMessage failed');
    return undefined;
  }
}
