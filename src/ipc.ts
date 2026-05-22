import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  MessageHandle,
  ProgressEvent,
  RegisteredGroup,
} from './types.js';
import {
  deleteAnchor,
  getProgressAnchor,
  markAnchorTerminal,
  ProgressAnchor,
  ProgressAnchorInput,
  updateAnchorLastProcessed,
  upsertProgressAnchor,
} from './db.js';

export interface IpcDeps {
  // Widened return type lets the progress consumer (U6) capture the anchor
  // MessageHandle when sending the initial 'started' event. Callers that
  // don't need the handle simply discard the return.
  sendMessage: (
    jid: string,
    text: string,
  ) => Promise<MessageHandle | undefined>;
  sendImage: (jid: string, paths: string[], caption?: string) => Promise<void>;
  sendVideo: (jid: string, paths: string[], caption?: string) => Promise<void>;
  // Routes a producer ProgressEvent through the channel layer — edit-in-place
  // when an anchor handle is present and the channel supports it, append
  // otherwise. Bypasses deduplicatedSend so rapid stage transitions are not
  // silently swallowed. Returns the new anchor handle on initial post, or
  // undefined when editing or when the channel can't produce an anchor.
  routeProgressNotice: (
    jid: string,
    event: ProgressEvent,
    anchorHandle: MessageHandle | undefined,
  ) => Promise<MessageHandle | undefined>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process image IPC files from this group's IPC directory
      const imagesDir = path.join(ipcBaseDir, sourceGroup, 'images');
      try {
        if (fs.existsSync(imagesDir)) {
          const imageFiles = fs
            .readdirSync(imagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of imageFiles) {
            const filePath = path.join(imagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processImageIpcFile(
                data,
                sourceGroup,
                isMain,
                registeredGroups,
                GROUPS_DIR,
                deps.sendImage,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC image',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC images directory',
        );
      }

      // Process video IPC files. Mirrors the image flow above; .mp4 extension
      // is enforced on the agent side at send_video time and re-validated here.
      const videosDir = path.join(ipcBaseDir, sourceGroup, 'videos');
      try {
        if (fs.existsSync(videosDir)) {
          const videoFiles = fs
            .readdirSync(videosDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of videoFiles) {
            const filePath = path.join(videosDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processVideoIpcFile(
                data,
                sourceGroup,
                isMain,
                registeredGroups,
                GROUPS_DIR,
                deps.sendVideo,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC video',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC videos directory',
        );
      }

      // Process progress IPC files. Critically diverges from the namespaces
      // above: non-terminal events do NOT unlink the file (the watchdog reads
      // last_update_at from SQLite, not the file). Only terminal kinds and
      // stale-leftover files are unlinked. Malformed/unauthorized payloads
      // are left on disk for post-mortem inspection rather than quarantined.
      const progressDir = path.join(ipcBaseDir, sourceGroup, 'progress');
      try {
        if (fs.existsSync(progressDir)) {
          const progressFiles = fs
            .readdirSync(progressDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of progressFiles) {
            const filePath = path.join(progressDir, file);
            try {
              const data = JSON.parse(
                fs.readFileSync(filePath, 'utf-8'),
              ) as ProgressEvent;
              const { shouldUnlink } = await processProgressIpcFile(
                data,
                sourceGroup,
                isMain,
                registeredGroups,
                {
                  getAnchor: getProgressAnchor,
                  upsertAnchor: upsertProgressAnchor,
                  markTerminal: markAnchorTerminal,
                  updateLastProcessed: updateAnchorLastProcessed,
                },
                deps.routeProgressNotice,
              );
              if (shouldUnlink) {
                try {
                  fs.unlinkSync(filePath);
                  // Best-effort delete the anchor row for terminal cleanup —
                  // the watchdog already skips terminal anchors via the
                  // (terminal_state IS NULL) predicate, but leaving them
                  // around forever bloats the DB.
                  deleteAnchor(data.request_id);
                } catch {
                  // File may have been unlinked by a concurrent process;
                  // ignore so the consumer doesn't crash on a race.
                }
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC progress event',
              );
              // Do NOT move malformed progress files to errors/ — leaving
              // the file in place lets the producer's next emit (latest-wins)
              // overwrite it cleanly. A persistently broken producer surfaces
              // via the logged error.
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC progress directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

export interface ImageIpcPayload {
  type?: string;
  chatJid?: string;
  groupFolder?: string;
  paths?: string[];
  caption?: string;
  timestamp?: string;
}

export async function processImageIpcFile(
  data: ImageIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  groupsRoot: string,
  sendImage: (jid: string, paths: string[], caption?: string) => Promise<void>,
): Promise<void> {
  if (
    data.type !== 'image' ||
    !data.chatJid ||
    !Array.isArray(data.paths) ||
    data.paths.length === 0
  ) {
    return;
  }

  const targetGroup = registeredGroups[data.chatJid];
  if (!(isMain || (targetGroup && targetGroup.folder === sourceGroup))) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC image attempt blocked',
    );
    return;
  }

  const groupRoot = path.join(groupsRoot, sourceGroup);
  const absolute: string[] = [];
  for (const rel of data.paths) {
    const abs = path.resolve(groupRoot, rel);
    if (abs !== groupRoot && !abs.startsWith(groupRoot + path.sep)) {
      logger.warn(
        { rel, sourceGroup },
        'IPC image path escapes group root, skipped',
      );
      continue;
    }
    if (!fs.existsSync(abs)) {
      logger.warn(
        { abs, sourceGroup },
        'IPC image file missing on host, skipped',
      );
      continue;
    }
    absolute.push(abs);
  }

  if (absolute.length) {
    await sendImage(data.chatJid, absolute, data.caption);
    logger.info(
      { chatJid: data.chatJid, count: absolute.length, sourceGroup },
      'IPC image delivered',
    );
  }
}

export interface VideoIpcPayload {
  type?: string;
  chatJid?: string;
  groupFolder?: string;
  paths?: string[];
  caption?: string;
  timestamp?: string;
}

// --- Progress IPC consumer (video-progress feedback layer) ---

export interface ProgressIpcAccessors {
  getAnchor: (requestId: string) => ProgressAnchor | undefined;
  upsertAnchor: (input: ProgressAnchorInput) => void;
  markTerminal: (
    requestId: string,
    terminalState: 'completed' | 'failed' | 'stalled' | 'anchor_lost',
    lastStage?: string,
  ) => void;
  updateLastProcessed: (
    requestId: string,
    emittedAt: string,
    lastUpdateAt: string,
    lastStage?: string,
  ) => void;
}

function channelNameFromJid(jid: string): string {
  if (jid.startsWith('slack:')) return 'slack';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'))
    return 'whatsapp';
  return 'unknown';
}

function isValidProgressEvent(data: unknown): data is ProgressEvent {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.request_id === 'string' &&
    typeof d.chat_jid === 'string' &&
    typeof d.kind === 'string' &&
    typeof d.stage === 'string' &&
    typeof d.elapsed_sec === 'number' &&
    typeof d.emitted_at === 'string'
  );
}

/**
 * Pure-function consumer for one progress IPC event. Returns whether the
 * caller should unlink the file (terminal or stale-leftover) or leave it
 * for the next poll tick (in-flight, dedup-skipped, or malformed).
 *
 * Diverges from the other IPC consumers in two ways the doc-review
 * surfaced as load-bearing:
 *  - Non-terminal files persist; the watchdog reads SQLite, not file mtime.
 *  - Event-sequence dedup via last_processed_emitted_at on the anchor row
 *    prevents the 1s IPC poll from re-firing updates for the same content.
 *
 * The orchestrator's per-jid `outputSentToUser` flag (src/index.ts) MUST
 * NOT be touched here: retry-on-error semantics depend on the flag staying
 * false until the agent's actual streamed text lands. Progress events are
 * not "agent output."
 */
export async function processProgressIpcFile(
  data: ProgressEvent,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  accessors: ProgressIpcAccessors,
  routeProgressNotice: (
    jid: string,
    event: ProgressEvent,
    anchorHandle: MessageHandle | undefined,
  ) => Promise<MessageHandle | undefined>,
): Promise<{ shouldUnlink: boolean }> {
  if (!isValidProgressEvent(data)) {
    logger.warn(
      { data, sourceGroup },
      'Malformed progress IPC payload, skipping (file kept for diagnostic)',
    );
    return { shouldUnlink: false };
  }

  const targetGroup = registeredGroups[data.chat_jid];
  if (!(isMain || (targetGroup && targetGroup.folder === sourceGroup))) {
    logger.warn(
      { chatJid: data.chat_jid, sourceGroup },
      'Unauthorized progress IPC attempt blocked',
    );
    return { shouldUnlink: false };
  }

  const anchor = accessors.getAnchor(data.request_id);
  const isTerminal = data.kind === 'done' || data.kind === 'failed';
  const terminalState: 'completed' | 'failed' =
    data.kind === 'done' ? 'completed' : 'failed';

  // Stale leftover: anchor already terminal. Drop the file silently.
  if (anchor && anchor.terminal_state !== null) {
    return { shouldUnlink: true };
  }

  // Event-sequence dedup: skip when emitted_at is not strictly newer than
  // the last event we processed. Without this the 1s IPC poll re-fires
  // updateMessage for the same file content every tick.
  if (
    anchor &&
    anchor.last_processed_emitted_at !== null &&
    data.emitted_at <= anchor.last_processed_emitted_at
  ) {
    return { shouldUnlink: false };
  }

  const now = new Date().toISOString();

  // No anchor yet → first time we see this request. Post the initial
  // anchor, capture the handle, and persist the row.
  if (!anchor) {
    const handle = await routeProgressNotice(
      data.chat_jid,
      data,
      undefined,
    );

    if (handle !== undefined) {
      accessors.upsertAnchor({
        request_id: data.request_id,
        chat_jid: data.chat_jid,
        channel: channelNameFromJid(data.chat_jid),
        handle,
        last_stage: data.stage,
        model_id: data.model_id ?? null,
        created_at: now,
        last_update_at: now,
      });
      accessors.updateLastProcessed(
        data.request_id,
        data.emitted_at,
        now,
        data.stage,
      );
      if (isTerminal) {
        accessors.markTerminal(data.request_id, terminalState, data.stage);
      }
    }
    return { shouldUnlink: isTerminal };
  }

  // Anchor exists, non-terminal: dispatch the update through the channel
  // (edit-in-place when supported, suppressed tick otherwise — the router
  // owns the channel-policy decision).
  await routeProgressNotice(data.chat_jid, data, anchor.handle);

  if (isTerminal) {
    accessors.markTerminal(data.request_id, terminalState, data.stage);
    return { shouldUnlink: true };
  }

  accessors.updateLastProcessed(
    data.request_id,
    data.emitted_at,
    now,
    data.stage,
  );
  return { shouldUnlink: false };
}

export async function processVideoIpcFile(
  data: VideoIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  groupsRoot: string,
  sendVideo: (jid: string, paths: string[], caption?: string) => Promise<void>,
): Promise<void> {
  if (
    data.type !== 'video' ||
    !data.chatJid ||
    !Array.isArray(data.paths) ||
    data.paths.length === 0
  ) {
    return;
  }

  const targetGroup = registeredGroups[data.chatJid];
  if (!(isMain || (targetGroup && targetGroup.folder === sourceGroup))) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC video attempt blocked',
    );
    return;
  }

  const groupRoot = path.join(groupsRoot, sourceGroup);
  const absolute: string[] = [];
  for (const rel of data.paths) {
    const abs = path.resolve(groupRoot, rel);
    if (abs !== groupRoot && !abs.startsWith(groupRoot + path.sep)) {
      logger.warn(
        { rel, sourceGroup },
        'IPC video path escapes group root, skipped',
      );
      continue;
    }
    if (!abs.toLowerCase().endsWith('.mp4')) {
      logger.warn({ abs, sourceGroup }, 'IPC video path is not .mp4, skipped');
      continue;
    }
    if (!fs.existsSync(abs)) {
      logger.warn(
        { abs, sourceGroup },
        'IPC video file missing on host, skipped',
      );
      continue;
    }
    absolute.push(abs);
  }

  if (absolute.length) {
    await sendVideo(data.chatJid, absolute, data.caption);
    logger.info(
      { chatJid: data.chatJid, count: absolute.length, sourceGroup },
      'IPC video delivered',
    );
  }
}
