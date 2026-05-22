export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64, already resized + encoded by the inbound channel
  // Optional inbox-relative path (e.g. "inbox/2026-05-20T143012Z-F012345.jpg")
  // populated when the channel materializes the image to /workspace/group/.
  // Agents read the path from the in-message marker block, not this field —
  // it exists for tests and future channel parity.
  path?: string;
}

export interface VideoAttachment {
  mediaType: 'video/mp4' | 'video/quicktime';
  // Inbox-relative path (e.g. "inbox/2026-05-20T143012Z-F012345.mp4").
  // Required: videos always travel via disk; there is no inline-base64 form.
  path: string;
  sizeBytes: number;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  images?: ImageAttachment[];
  videos?: VideoAttachment[];
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

// Opaque per-channel message handle. The orchestrator stores and round-trips
// this string without parsing — each channel encodes its own native identifier
// (Slack: "<channelId>:<ts>"; Telegram/Discord: "<chatId>:<messageId>"). Used
// by Channel.updateMessage? to edit a previously sent message in place.
export type MessageHandle = string;

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<MessageHandle | undefined>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send image. Channels that support image delivery implement it.
  sendImage?(
    jid: string,
    imagePaths: string[],
    caption?: string,
  ): Promise<MessageHandle | undefined>;
  // Optional: send video. Channels that support video delivery implement it.
  sendVideo?(
    jid: string,
    videoPaths: string[],
    caption?: string,
  ): Promise<MessageHandle | undefined>;
  // Optional: edit a previously sent message in place. Channels whose platform
  // supports it (Slack chat.update, Telegram editMessageText, Discord followup
  // edit) implement it; channels without an edit primitive (Gmail, WhatsApp
  // Business) omit it and the orchestrator falls back to append-on-stage.
  updateMessage?(
    jid: string,
    handle: MessageHandle,
    newText: string,
  ): Promise<void>;
}

// --- Progress lifecycle event schema ---

// Producer lifecycle kinds. 'failed' is producer-known failure (terminal);
// orchestrator-detected stalls reuse the FailureKind 'stalled' kind in
// src/router.ts, not a progress kind.
export type ProgressKind = 'started' | 'tick' | 'stage' | 'done' | 'failed';

// Generic across video providers — no Veo / Omni / Sora-specific fields.
// The schema lives next to the helper at container/lib/progress.py.
export interface ProgressEvent {
  request_id: string;
  // The chat the producer is rendering for. Set by the helper from
  // NANOCLAW_CHAT_JID so the orchestrator can route the 'started' event
  // before an anchor row exists in progress_anchors.
  chat_jid: string;
  kind: ProgressKind;
  stage: string;
  elapsed_sec: number;
  eta_sec?: number;
  percent?: number;
  next_stage?: string;
  model_id?: string;
  // Only present on kind='done'. Workspace-relative path the agent's
  // send_video MCP call would also accept.
  media_path?: string;
  // Only present on kind='failed'. Producer-known reason (e.g., "quota").
  reason?: string;
  // ISO-8601 monotonic per-request; the consumer uses this for event-sequence
  // dedup so a 1s IPC poll re-reading the persistent file doesn't re-dispatch
  // the same update every tick.
  emitted_at: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
