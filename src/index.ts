import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';

// Apply proxy settings from .env before any network requests
const proxyVars = readEnvFile(['https_proxy', 'http_proxy', 'no_proxy']);
for (const [key, value] of Object.entries(proxyVars)) {
  if (!process.env[key]) process.env[key] = value;
  // Also set uppercase variants
  if (!process.env[key.toUpperCase()]) process.env[key.toUpperCase()] = value;
}

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AgentProfile,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { startDashboard } from './web/server.js';
import { agentEvents } from './web/events.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  CREDENTIAL_PROXY_PORT,
  INTELLIGENCE_MODULE,
  PIPELINE_AUTO,
} from './config.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  ensureImageAvailable,
  killContainer,
} from './container-runtime.js';
import {
  assignWebChatThreadSession,
  createWebChatThread,
  deleteWebChatThread,
  getAllChats,
  getAllRegisteredGroups,
  deleteSession,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getActiveWebChatThreadId,
  getRouterState,
  getWebChatThread,
  initDatabase,
  listWebChatThreads,
  renameWebChatThread,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setActiveWebChatThreadId,
  storeChatMetadata,
  storeMessage,
  markMessageAsBot,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { setWebChatActiveThread } from './channels/web.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let previousSessions: Record<string, string> = {}; // saved before /new, restored by /resume
let previousPipelineFlags: Record<string, { pipeline_notified?: boolean; modeling_notified?: boolean }> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const WEB_CHAT_FOLDER = 'web_chat';
const WEB_CHAT_JID = 'web:chat';

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function syncWebChatRuntimeSession(
  threadId: string,
  syncOutputThread = true,
): void {
  const thread = getWebChatThread(threadId);
  if (!thread) return;
  setActiveWebChatThreadId(threadId);
  if (syncOutputThread) {
    setWebChatActiveThread(threadId);
  }

  if (thread.agent_session_id) {
    sessions[WEB_CHAT_FOLDER] = thread.agent_session_id;
    setSession(WEB_CHAT_FOLDER, thread.agent_session_id);
  } else {
    clearAllGroupSessions(WEB_CHAT_FOLDER);
  }
}

function activateWebChatThread(threadId: string): void {
  const currentThreadId = getActiveWebChatThreadId();
  if (currentThreadId === threadId) {
    syncWebChatRuntimeSession(threadId);
    return;
  }
  const state = queue.getState(WEB_CHAT_JID);
  const hasRunningWebAgent = !!(state?.active && state.process);
  // Don't kill running container — let it finish its current task.
  // Just switch the active thread so new messages go to the new thread.
  syncWebChatRuntimeSession(threadId, !hasRunningWebAgent);
}

function getAgentCursorKey(chatJid: string, threadId?: string): string {
  if (chatJid === WEB_CHAT_JID) {
    return `${chatJid}:${threadId || getActiveWebChatThreadId()}`;
  }
  return chatJid;
}

function deleteAndReplaceWebChatThread(threadId: string):
  | {
      deletedThreadId: string;
      activeThreadId: string;
      activeSession: NonNullable<ReturnType<typeof getWebChatThread>>;
    }
  | undefined {
  const target = getWebChatThread(threadId);
  if (!target) return undefined;

  const existing = listWebChatThreads().filter(
    (thread) => thread.id !== threadId,
  );
  let fallback = existing[0];
  if (!fallback) {
    fallback = createWebChatThread('New chat');
  }

  const activeThreadId = getActiveWebChatThreadId();
  deleteWebChatThread(threadId);

  if (activeThreadId === threadId) {
    activateWebChatThread(fallback.id);
  } else if (!getWebChatThread(activeThreadId)) {
    activateWebChatThread(fallback.id);
  }

  const nextActive = getWebChatThread(getActiveWebChatThreadId());
  if (!nextActive) return undefined;

  return {
    deletedThreadId: threadId,
    activeThreadId: getActiveWebChatThreadId(),
    activeSession: nextActive,
  };
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const activeThreadId =
    group.folder === WEB_CHAT_FOLDER ? getActiveWebChatThreadId() : undefined;
  const cursorKey = getAgentCursorKey(chatJid, activeThreadId);
  const sinceTimestamp = lastAgentTimestamp[cursorKey] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
    activeThreadId,
  );

  if (missedMessages.length === 0) return true;

  // Session control commands (/watch, /stop, /new, /mode, /proceed, etc.)
  // are handled in handleControlCommand() which runs BEFORE processGroupMessages.
  // Safety fallback: if a control command somehow reaches here, consume it.
  const lastMsg = missedMessages[missedMessages.length - 1].content.trim();

  // /compact is special: rewrite the message content but don't return (let it flow to agent)
  if (/^\/compact\b/i.test(lastMsg)) {
    const focus = lastMsg.replace(/^\/compact\s*/i, '').trim();
    missedMessages[missedMessages.length - 1] = {
      ...missedMessages[missedMessages.length - 1],
      content: focus
        ? `[SYSTEM] Compress and reorganize your current memory. Focus on: ${focus}. Discard everything not related to this focus. Summarize what you kept.`
        : '[SYSTEM] Summarize your current memory and context into a concise form. Forget unnecessary details, keep only the key facts, decisions, and ongoing tasks. After summarizing, confirm what you remember.',
    };
  } else if (
    /^\/(watch|help|stop|status|sessions|new|resume|mode|proceed)\b/i.test(
      lastMsg,
    )
  ) {
    // Safety fallback: these commands should have been handled by handleControlCommand().
    // If they somehow reach here, consume them to prevent sending to the agent.
    lastAgentTimestamp[cursorKey] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[cursorKey] || '';
  lastAgentTimestamp[cursorKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[cursorKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

/**
 * Get the current operating mode.
 * Respects runtime override from interactive toggle.
 */
type OperatingMode =
  | 'compute'
  | 'intelligence'
  | 'modeling'
  | 'modeling+compute'
  | 'intelligence+compute';

function getOperatingMode(group?: RegisteredGroup): OperatingMode {
  // Per-group override takes priority (set by /mode in that group)
  const groupMode = group?.containerConfig?.mode;
  if (
    groupMode === 'intelligence' ||
    groupMode === 'intelligence+compute' ||
    groupMode === 'modeling' ||
    groupMode === 'modeling+compute' ||
    groupMode === 'compute'
  )
    return groupMode;

  // Fall back to global .env setting
  const freshConfig = readEnvFile(['INTELLIGENCE_MODE']);
  const mode = freshConfig.INTELLIGENCE_MODE;
  if (
    mode === 'intelligence' ||
    mode === 'intelligence+compute' ||
    mode === 'modeling' ||
    mode === 'modeling+compute'
  )
    return mode;
  const intellEnabled =
    (globalThis as any).__INTELLIGENCE_MODULE_OVERRIDE ?? INTELLIGENCE_MODULE;
  return intellEnabled ? 'intelligence+compute' : 'compute';
}

/**
 * Determine the agent profile for a given run.
 * In pipeline mode (intelligence+compute), returns 'intelligence' for phase 1.
 */

/**
 * Pipeline state per group — tracks which files the current run produced.
 * Stored at groups/{folder}/.pipeline_state.json.
 * Each session's agent writes its output files; the host records the paths here.
 * When user switches sessions or /proceed, we know exactly which files to use.
 */
interface PipelineState {
  research_decision?: string; // host path to research_decision.json
  computation_plan?: string; // host path to computation_plan.json
  report_dir?: string; // host path to the run directory
  updated_at?: string;
}

function getPipelineStatePath(groupFolder: string): string {
  return path.join(resolveGroupFolderPath(groupFolder), '.pipeline_state.json');
}

function readPipelineState(groupFolder: string): PipelineState {
  const statePath = getPipelineStatePath(groupFolder);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch {
    /* corrupt file */
  }
  return {};
}

function writePipelineState(groupFolder: string, state: PipelineState): void {
  state.updated_at = new Date().toISOString();
  const statePath = getPipelineStatePath(groupFolder);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function clearPipelineState(groupFolder: string): void {
  const statePath = getPipelineStatePath(groupFolder);
  try {
    fs.unlinkSync(statePath);
  } catch {
    /* doesn't exist */
  }
}

/**
 * Scan a group directory for a pipeline output file.
 * First checks pipeline_state.json for recorded path.
 * Falls back to searching the group directory recursively.
 */
function findPipelineFile(
  groupFolder: string,
  filename: string,
): string | null {
  // Priority 1: recorded in pipeline state
  const state = readPipelineState(groupFolder);
  const key =
    filename === 'research_decision.json'
      ? 'research_decision'
      : 'computation_plan';
  const recorded = state[key as keyof PipelineState] as string | undefined;
  if (recorded && fs.existsSync(recorded)) return recorded;

  // Priority 2: search group directory
  const groupDir = resolveGroupFolderPath(groupFolder);
  const results: { path: string; mtime: number }[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name === filename) {
          const stat = fs.statSync(fullPath);
          results.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      }
    } catch {
      /* ignore */
    }
  }

  walk(groupDir, 0);
  if (results.length === 0) return null;
  results.sort((a, b) => b.mtime - a.mtime);

  // Record it for next time
  const found = results[0].path;
  state[key as keyof PipelineState] = found as any;
  writePipelineState(groupFolder, state);

  return found;
}

function getAgentProfile(): AgentProfile {
  const mode = getOperatingMode();
  if (mode === 'intelligence') return 'intelligence';
  if (mode === 'compute') return 'compute';
  // intelligence+compute: default to intelligence for first run
  // (pipeline logic in runAgent handles the handoff)
  return null; // null = all skills (for non-pipeline runs)
}

/**
 * Get the session storage key for a given group + profile combination.
 * In pipeline mode, each profile gets its own session namespace.
 */
function sessionKey(groupFolder: string, profile: AgentProfile): string {
  if (profile) return `${groupFolder}:${profile}`;
  return groupFolder;
}

/** Clear all session keys for a group, including profile-scoped ones and pipeline state. */
function clearAllGroupSessions(groupFolder: string): void {
  clearPipelineState(groupFolder);
  const profiles: AgentProfile[] = ['intelligence', 'modeling', 'compute'];
  // Clear base session
  delete sessions[groupFolder];
  deleteSession(groupFolder);
  // Clear all profile-scoped sessions
  for (const p of profiles) {
    const key = `${groupFolder}:${p}`;
    delete sessions[key];
    deleteSession(key);
  }
  // Clear pipeline notification flags
  delete (globalThis as any)[`${groupFolder}:pipeline_notified`];
  delete (globalThis as any)[`${groupFolder}:modeling_notified`];
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  profileOverride?: AgentProfile,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const mode = getOperatingMode(group);
  const profileMap: Record<string, AgentProfile> = {
    intelligence: 'intelligence',
    compute: 'compute',
    modeling: 'modeling',
  };
  const profile = profileOverride ?? profileMap[mode] ?? null;
  // Pipeline modes: start with the first agent in the chain
  const effectiveProfile =
    mode === 'intelligence+compute' && !profileOverride
      ? ('intelligence' as AgentProfile)
      : mode === 'modeling+compute' && !profileOverride
        ? ('modeling' as AgentProfile)
        : profile;
  const sKey = sessionKey(group.folder, effectiveProfile);
  const sessionId = sessions[sKey] || sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Capture the thread ID at start — don't use getActiveWebChatThreadId() later
  // because the user may switch threads while the agent is still running.
  const startingThreadId =
    group.folder === WEB_CHAT_FOLDER ? getActiveWebChatThreadId() : null;

  // Wrap onOutput to track session ID from streamed results.
  const makeWrappedOnOutput = (phaseKey: string) =>
    onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId && !queue.isSessionCleared(chatJid)) {
            sessions[phaseKey] = output.newSessionId;
            setSession(phaseKey, output.newSessionId);
            if (startingThreadId) {
              assignWebChatThreadSession(
                startingThreadId,
                output.newSessionId,
              );
            }
          }
          await onOutput(output);
        }
      : undefined;
  const wrappedOnOutput = makeWrappedOnOutput(sKey);

  try {
    // /proceed command sets __PIPELINE_FORCE_COMPUTE to skip re-running Phase 1.
    // Phase 1 already ran and produced its output file; the pipeline handoff
    // code below constructs proper prompts for subsequent phases.
    const forceKey = `${group.folder}:__PIPELINE_FORCE_COMPUTE`;
    const forceCompute = (globalThis as any)[forceKey];
    if (forceCompute) delete (globalThis as any)[forceKey];

    // Helper: check if /stop was issued during a pipeline phase transition
    const cancelledKey = `${group.folder}:__PIPELINE_CANCELLED`;
    const isPipelineCancelled = () => {
      if ((globalThis as any)[cancelledKey]) {
        delete (globalThis as any)[cancelledKey];
        logger.info({ group: group.name }, 'Pipeline cancelled by /stop');
        return true;
      }
      return false;
    };

    // Skip Phase 1 when /proceed forces the pipeline forward —
    // Phase 1 already ran and produced its pipeline file.
    const skipPhase1 =
      forceCompute &&
      !profileOverride &&
      (mode === 'intelligence+compute' || mode === 'modeling+compute');

    if (!skipPhase1) {
      // ── Phase 1: Run the primary agent ──
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
        effectiveProfile,
      );

      if (output.newSessionId && !queue.isSessionCleared(chatJid)) {
        sessions[sKey] = output.newSessionId;
        setSession(sKey, output.newSessionId);
        if (startingThreadId) {
          assignWebChatThreadSession(startingThreadId, output.newSessionId);
        }
        logger.debug(
          { sessionKey: sKey, sessionId: output.newSessionId },
          'Session saved',
        );
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }
    }

    if (mode === 'intelligence+compute' && !profileOverride) {
      const groupDir = resolveGroupFolderPath(group.folder);
      const decisionPath = findPipelineFile(
        group.folder,
        'research_decision.json',
      );

      // Track whether we've already notified the user about the decision.
      // This prevents re-showing the /proceed prompt on every follow-up message
      // while the user is still refining the intelligence analysis.
      const notifiedKey = `${group.folder}:pipeline_notified`;
      const decisionExists = !!decisionPath;
      const alreadyNotified = (globalThis as any)[notifiedKey];

      if (decisionExists && !alreadyNotified) {
        const shouldAutoRun = PIPELINE_AUTO || forceCompute;

        // Mark as notified so follow-up messages don't re-trigger
        (globalThis as any)[notifiedKey] = true;

        if (!shouldAutoRun) {
          // Manual mode: notify user, wait for /proceed
          // User can continue chatting with intelligence agent to refine
          logger.info(
            { group: group.name },
            'Pipeline: intelligence phase complete, waiting for user /proceed',
          );
          const channel = findChannel(channels, chatJid);
          if (channel) {
            await channel.sendMessage(
              chatJid,
              [
                'Research decision generated.',
                '',
                'You can continue chatting to refine the analysis, or:',
                '/proceed — start computation based on research decision',
                '/mode compute — switch to computation only',
              ].join('\n'),
            );
          }
          return 'success';
        }

        logger.info(
          { group: group.name },
          'Pipeline: intelligence complete, starting modeling phase',
        );

        const channel = findChannel(channels, chatJid);

        // Check if /stop was issued between phases
        if (isPipelineCancelled()) return 'error';

        // ── Phase 2: Modeling Agent ──
        // Reads research_decision.json → designs physical model + computational approach
        // Outputs computation_plan.json
        if (channel) {
          await channel.sendMessage(
            chatJid,
            'Starting scientific modeling phase — designing computational approach...',
          );
        }

        const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf-8'));
        const topicTitle = Array.isArray(decision)
          ? decision[0]?.title || 'See file'
          : decision.title || 'See file';

        // Convert host path to container path
        const containerDecisionPath = decisionPath!.replace(
          groupDir,
          '/workspace/group',
        );

        const modelingPrompt = [
          '[SYSTEM] Pipeline handoff: Intelligence → Modeling.',
          '',
          'A research direction has been decided. Read:',
          containerDecisionPath,
          '',
          'Your task: Design the complete computational approach.',
          'Follow the workflow in your modeling SKILL.md:',
          '1. Understand the physical problem',
          '2. Research the physics (use WebSearch)',
          '3. Select physical model and mathematical framework',
          '4. Choose computational methods (DFT/MLIP/MD/MC)',
          '5. Determine ALL parameters with justification',
          '6. Design convergence tests',
          '7. Design validation strategy',
          '8. Write computation_plan.json',
          '',
          `Topic: ${topicTitle}`,
        ].join('\n');

        const modelingKey = sessionKey(group.folder, 'modeling');
        const modelingResult = await runContainerAgent(
          group,
          {
            prompt: modelingPrompt,
            sessionId: sessions[modelingKey],
            groupFolder: group.folder,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
          },
          (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, group.folder),
          makeWrappedOnOutput(modelingKey),
          'modeling',
        );

        if (modelingResult.newSessionId && !queue.isSessionCleared(chatJid)) {
          sessions[modelingKey] = modelingResult.newSessionId;
          setSession(modelingKey, modelingResult.newSessionId);
        }

        if (modelingResult.status === 'error') {
          logger.error(
            { group: group.name },
            'Pipeline: modeling phase failed',
          );
          // Reset pipeline_notified so a new message can re-trigger the pipeline
          delete (globalThis as any)[notifiedKey];
          return 'error';
        }

        // Check if modeling produced computation_plan.json
        const planPath = findPipelineFile(
          group.folder,
          'computation_plan.json',
        );
        const modelingNotifiedKey = `${group.folder}:modeling_notified`;

        if (!(globalThis as any)[modelingNotifiedKey]) {
          (globalThis as any)[modelingNotifiedKey] = true;

          if (!PIPELINE_AUTO && !forceCompute) {
            // Manual mode: pause for user review
            logger.info(
              { group: group.name },
              'Pipeline: modeling complete, waiting for user /proceed',
            );
            if (channel) {
              const hasPlanMsg = planPath
                ? 'Computation plan generated.'
                : 'No computation_plan.json yet.';
              await channel.sendMessage(
                chatJid,
                [
                  `Modeling phase complete. ${hasPlanMsg}`,
                  '',
                  'You can continue chatting to refine, or:',
                  '/proceed — start computation',
                ].join('\n'),
              );
            }
            return 'success';
          }
        } else if (!planPath) {
          logger.info(
            { group: group.name },
            'Pipeline: no computation_plan.json, stopping',
          );
          if (channel) {
            await channel.sendMessage(
              chatJid,
              'Modeling complete but no computation plan generated.',
            );
          }
          return 'success';
        }

        // ── Phase 3: Compute Agent ──
        if (isPipelineCancelled()) return 'error';
        if (!planPath) {
          logger.info(
            { group: group.name },
            'Pipeline: no computation_plan.json after modeling, stopping',
          );
          if (channel) {
            await channel.sendMessage(
              chatJid,
              'Modeling complete but no computation plan generated. Use /proceed after the plan is ready.',
            );
          }
          return 'success';
        }

        if (channel) {
          await channel.sendMessage(chatJid, 'Starting computation phase...');
        }

        const containerPlanPath = planPath.replace(
          groupDir,
          '/workspace/group',
        );

        const computePrompt = [
          '[SYSTEM] Pipeline handoff: Modeling → Computation.',
          '',
          'A computational plan has been designed. Read:',
          containerPlanPath,
          '',
          'Execute the calculations as specified in the plan.',
          'Follow the parameters, convergence tests, and validation strategy exactly.',
          '',
          `Topic: ${topicTitle}`,
        ].join('\n');

        // Reset notification flags for next pipeline run
        delete (globalThis as any)[modelingNotifiedKey];

        const computeKey = sessionKey(group.folder, 'compute');
        const computeResult = await runContainerAgent(
          group,
          {
            prompt: computePrompt,
            sessionId: sessions[computeKey],
            groupFolder: group.folder,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
          },
          (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, group.folder),
          makeWrappedOnOutput(computeKey),
          'compute',
        );
        if (computeResult.newSessionId && !queue.isSessionCleared(chatJid)) {
          sessions[computeKey] = computeResult.newSessionId;
          setSession(computeKey, computeResult.newSessionId);
          logger.debug(
            { sessionKey: computeKey, sessionId: computeResult.newSessionId },
            'Compute session saved',
          );
        }

        // Reset pipeline_notified so next user message can trigger a fresh pipeline
        delete (globalThis as any)[notifiedKey];

        if (computeResult.status === 'error') {
          logger.error({ group: group.name }, 'Pipeline: compute phase failed');
          return 'error';
        } else {
          logger.info(
            { group: group.name },
            'Pipeline: compute phase complete',
          );
        }
      } else {
        logger.debug(
          { group: group.name },
          'Pipeline: no research_decision.json found, skipping compute phase',
        );
      }
    }

    // ── modeling+compute pipeline ──
    // After modeling phase, ALWAYS pause for user review (unless auto/force).
    // This ensures modeling and compute are truly decoupled — user decides when to proceed.
    if (mode === 'modeling+compute' && !profileOverride) {
      const groupDir = resolveGroupFolderPath(group.folder);
      const planPath = findPipelineFile(group.folder, 'computation_plan.json');
      const modelingNotifiedKey = `${group.folder}:modeling_notified`;

      if (!(globalThis as any)[modelingNotifiedKey]) {
        (globalThis as any)[modelingNotifiedKey] = true;

        if (!PIPELINE_AUTO && !forceCompute) {
          logger.info(
            { group: group.name },
            'Pipeline: modeling phase complete, waiting for /proceed',
          );
          const channel = findChannel(channels, chatJid);
          if (channel) {
            const hasplan = planPath
              ? 'computation_plan.json generated.'
              : 'No computation_plan.json yet.';
            await channel.sendMessage(
              chatJid,
              [
                `Modeling phase complete. ${hasplan}`,
                '',
                'You can continue chatting to refine the modeling, or:',
                '/proceed — start computation',
              ].join('\n'),
            );
          }
          return 'success';
        }

        // Auto mode: proceed to compute
        if (!planPath) {
          logger.info(
            { group: group.name },
            'Pipeline: no computation_plan.json after modeling, stopping',
          );
          const ch = findChannel(channels, chatJid);
          if (ch) {
            await ch.sendMessage(
              chatJid,
              'Modeling complete but no computation plan generated. Use /proceed after the plan is ready.',
            );
          }
          return 'success';
        }

        if (isPipelineCancelled()) return 'error';

        const channel = findChannel(channels, chatJid);
        if (channel) {
          await channel.sendMessage(chatJid, 'Starting computation phase...');
        }

        delete (globalThis as any)[modelingNotifiedKey];

        const containerPlanPath = planPath.replace(
          groupDir,
          '/workspace/group',
        );

        const computePrompt = [
          '[SYSTEM] Pipeline handoff: Modeling → Computation.',
          '',
          'A computational plan has been designed. Read:',
          containerPlanPath,
          '',
          'Execute the calculations as specified in the plan.',
          'Follow the parameters, convergence tests, and validation strategy exactly.',
        ].join('\n');

        const computeKey = sessionKey(group.folder, 'compute');
        const computeResult = await runContainerAgent(
          group,
          {
            prompt: computePrompt,
            sessionId: sessions[computeKey],
            groupFolder: group.folder,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
          },
          (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, group.folder),
          makeWrappedOnOutput(computeKey),
          'compute',
        );

        if (computeResult.newSessionId && !queue.isSessionCleared(chatJid)) {
          sessions[computeKey] = computeResult.newSessionId;
          setSession(computeKey, computeResult.newSessionId);
        }

        // Reset modeling_notified so next pipeline run can trigger compute
        delete (globalThis as any)[modelingNotifiedKey];

        if (computeResult.status === 'error') {
          logger.error(
            { group: group.name },
            'Pipeline: compute phase failed (modeling+compute)',
          );
          return 'error';
        }
      }
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Handle control commands (/stop, /new, /watch, /status, /help, /sessions)
 * that should work even while the agent container is running.
 * Returns true if the message was a control command and was handled.
 */
async function handleControlCommand(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
  messages: NewMessage[],
): Promise<boolean> {
  const threadId =
    group.folder === WEB_CHAT_FOLDER
      ? messages[messages.length - 1].thread_id || getActiveWebChatThreadId()
      : undefined;
  const cursorKey = getAgentCursorKey(chatJid, threadId);
  const lastMsg = messages[messages.length - 1].content.trim();

  // Helper: consume the command without losing earlier messages in the batch.
  // Mark the command as a bot message (so getMessagesSince filters it out),
  // then re-enqueue if there were earlier non-command messages.
  const consumeCommand = () => {
    const cmdMsg = messages[messages.length - 1];
    // Mark command as bot message so it won't be re-fetched by getMessagesSince
    markMessageAsBot(cmdMsg.id);
    if (messages.length > 1) {
      // Don't advance cursor — earlier messages are still fetchable.
      // The command itself is now filtered by is_bot_message = 0 in queries.
      queue.enqueueMessageCheck(chatJid);
    } else {
      // Only the command in the batch — advance cursor past it
      lastAgentTimestamp[cursorKey] = cmdMsg.timestamp;
      saveState();
    }
  };

  // ── /mode — switch operating mode ──
  if (/^\/mode\b/i.test(lastMsg)) {
    consumeCommand();
    const arg = lastMsg
      .replace(/^\/mode\s*/i, '')
      .trim()
      .toLowerCase();

    const validModes: Record<string, string> = {
      compute: 'compute',
      computation: 'compute',
      calc: 'compute',
      intelligence: 'intelligence',
      intel: 'intelligence',
      research: 'intelligence',
      modeling: 'modeling',
      model: 'modeling',
      design: 'modeling',
      'modeling+compute': 'modeling+compute',
      mc: 'modeling+compute',
      auto: 'intelligence+compute',
      pipeline: 'intelligence+compute',
      'intelligence+compute': 'intelligence+compute',
      full: 'intelligence+compute',
    };

    if (!arg) {
      const current = getOperatingMode(group);
      const modeLabels: Record<string, string> = {
        compute: 'Compute',
        intelligence: 'Intelligence',
        modeling: 'Modeling',
        'modeling+compute': 'Modeling → Compute',
        'intelligence+compute': 'Autonomous Research',
      };
      await channel.sendMessage(
        chatJid,
        [
          `Current mode: ${modeLabels[current] || current}`,
          '',
          'Available modes:',
          '/mode compute — DFT, MD, MLIP calculations',
          '/mode intelligence — research direction analysis',
          '/mode modeling — physical/mathematical modeling',
          '/mode mc — modeling → computation',
          '/mode auto — autonomous research (intelligence → modeling → computation)',
        ].join('\n'),
      );
      return true;
    }

    const newMode = validModes[arg];
    if (!newMode) {
      await channel.sendMessage(
        chatJid,
        `Unknown mode "${arg}". Use: compute, intelligence, or auto`,
      );
      return true;
    }

    // Write to .env
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf-8');
    } catch {
      /* */
    }

    const enableIntel = newMode !== 'compute';
    const updates: Record<string, string> = {
      INTELLIGENCE_MODULE: String(enableIntel),
      INTELLIGENCE_MODE: newMode,
    };
    for (const [key, val] of Object.entries(updates)) {
      if (new RegExp(`^${key}=`, 'm').test(envContent)) {
        envContent = envContent.replace(
          new RegExp(`^${key}=\\S*`, 'm'),
          `${key}=${val}`,
        );
      } else {
        envContent += `\n${key}=${val}`;
      }
    }
    fs.writeFileSync(envPath, envContent);
    (globalThis as any).__INTELLIGENCE_MODULE_OVERRIDE = enableIntel;

    // Set per-group mode override so this only affects this group
    if (!group.containerConfig) group.containerConfig = {};
    group.containerConfig.mode = newMode;
    registeredGroups[chatJid] = group;
    // Clear pipeline flags from previous mode to prevent stale state
    delete (globalThis as any)[`${group.folder}:pipeline_notified`];
    delete (globalThis as any)[`${group.folder}:modeling_notified`];
    delete (globalThis as any)[`${group.folder}:__PIPELINE_CANCELLED`];
    saveState();

    const modeLabels: Record<string, string> = {
      compute: 'Compute',
      intelligence: 'Intelligence',
      modeling: 'Modeling',
      'modeling+compute': 'Modeling → Compute',
      'intelligence+compute': 'Autonomous Research',
    };
    await channel.sendMessage(
      chatJid,
      `Mode switched to: ${modeLabels[newMode] || newMode}. Saved to .env.`,
    );
    // Broadcast mode change to dashboard
    agentEvents.emit('agent', {
      type: 'status',
      group: group.name,
      groupFolder: group.folder,
      timestamp: new Date().toISOString(),
      data: { mode: newMode, label: modeLabels[newMode] || newMode },
    });
    return true;
  }

  // ── /proceed — continue pipeline to next phase ──
  // Smart detection: checks what exists to determine next step
  //   research_decision.json exists, no computation_plan.json → proceed to modeling
  //   computation_plan.json exists → proceed to computation
  if (/^\/proceed\b/i.test(lastMsg)) {
    consumeCommand();

    // Stop any running agent before proceeding to next phase
    const state = queue.getState(chatJid);
    if (state?.active && state.process) {
      state.process.kill('SIGTERM');
      if (state.containerName) killContainer(state.containerName);
      logger.info({ group: group.name }, 'Agent stopped for /proceed');
    }

    const groupDir = resolveGroupFolderPath(group.folder);
    const decisionPath = findPipelineFile(
      group.folder,
      'research_decision.json',
    );
    const planPath = findPipelineFile(group.folder, 'computation_plan.json');

    const hasDecision = !!decisionPath;
    const hasPlan = !!planPath;

    if (!hasDecision && !hasPlan) {
      await channel.sendMessage(
        chatJid,
        'Nothing to proceed with. Run /mode intelligence or /mode modeling first.',
      );
      return true;
    }

    // Determine next phase
    let nextPhase: 'modeling' | 'compute';
    if (hasPlan) {
      // computation_plan.json exists → proceed to computation
      nextPhase = 'compute';
    } else {
      // only research_decision.json → proceed to modeling
      nextPhase = 'modeling';
    }

    const phaseLabels = {
      modeling: 'Proceeding to scientific modeling phase...',
      compute: 'Proceeding to computation phase...',
    };
    await channel.sendMessage(chatJid, phaseLabels[nextPhase]);

    // Reset notification flags
    delete (globalThis as any)[`${group.folder}:pipeline_notified`];
    delete (globalThis as any)[`${group.folder}:modeling_notified`];

    // Force the next phase to run (per-group to avoid cross-group interference)
    (globalThis as any)[`${group.folder}:__PIPELINE_FORCE_COMPUTE`] = true;

    // Inject a system message for the next agent
    const { storeMessage: dbStoreMessage } = await import('./db.js');
    const actualPath = nextPhase === 'modeling' ? decisionPath! : planPath!;
    const containerPath = actualPath.replace(
      resolveGroupFolderPath(group.folder),
      '/workspace/group',
    );
    const systemPrompt = `[SYSTEM] /proceed: User confirmed. Read ${containerPath} and execute your task.`;

    dbStoreMessage({
      id: `proceed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: chatJid,
      thread_id: threadId,
      sender: 'system',
      sender_name: 'Pipeline',
      content: systemPrompt,
      timestamp: new Date().toISOString(),
      is_from_me: true, // bypass trigger check so pipeline proceeds in non-main groups
      is_bot_message: false,
    });

    return true;
  }

  if (/^\/stop\b/i.test(lastMsg)) {
    consumeCommand();
    const state = queue.getState(chatJid);
    if (state?.active && state.process) {
      state.process.kill('SIGTERM');
      if (state.containerName) killContainer(state.containerName);
      // Set cancellation flag so pipeline phases don't continue after this kill
      (globalThis as any)[`${group.folder}:__PIPELINE_CANCELLED`] = true;
      logger.info({ group: group.name }, 'Agent stopped via /stop command');
      await channel.sendMessage(chatJid, 'Agent stopped.');
    } else {
      await channel.sendMessage(chatJid, 'No agent running.');
    }
    return true;
  }

  if (/^\/new\b/i.test(lastMsg)) {
    // Stop running container first
    const state = queue.getState(chatJid);
    if (state?.active && state.process) {
      // Mark session cleared BEFORE killing — prevents the dying container's
      // output callbacks from re-saving the old session ID, and blocks
      // sendMessage() from piping new messages to the old container.
      queue.markSessionCleared(chatJid);
      state.process.kill('SIGTERM');
      if (state.containerName) killContainer(state.containerName);
      logger.info({ group: group.name }, 'Agent stopped for /new command');
    }
    // Save any active session (base or profile-scoped) so /resume can restore it
    const activeSession = sessions[group.folder]
      || sessions[sessionKey(group.folder, 'intelligence')]
      || sessions[sessionKey(group.folder, 'modeling')]
      || sessions[sessionKey(group.folder, 'compute')];
    if (activeSession) {
      previousSessions[group.folder] = activeSession;
    }
    // Save pipeline notification flags so /resume can restore them
    previousPipelineFlags[group.folder] = {
      pipeline_notified: !!(globalThis as any)[`${group.folder}:pipeline_notified`],
      modeling_notified: !!(globalThis as any)[`${group.folder}:modeling_notified`],
    };
    clearAllGroupSessions(group.folder);
    consumeCommand();
    logger.info(
      { group: group.name },
      'Session reset via /new command (all profiles cleared)',
    );
    await channel.sendMessage(
      chatJid,
      'Session cleared (all agent profiles). Next message starts a fresh conversation.',
    );
    return true;
  }

  if (/^\/watch\b/i.test(lastMsg)) {
    consumeCommand();
    const liveLogPath = path.join(
      GROUPS_DIR,
      group.folder,
      'logs',
      'container-live.log',
    );
    if (!fs.existsSync(liveLogPath)) {
      await channel.sendMessage(chatJid, 'No agent activity yet.');
      return true;
    }
    const raw = fs.readFileSync(liveLogPath, 'utf-8');
    const allLines = raw.split('\n');
    const tail = allLines.slice(-200);
    const activities: string[] = [];
    for (const line of tail) {
      const m = line.match(/\[stderr\]\s*\[[\d:.]+\]\s*(.+)/);
      if (!m) continue;
      const content = m[1];
      if (content.startsWith('[ToolCall]')) {
        activities.push(content.replace('[ToolCall] ', ''));
      } else if (content.startsWith('[Assistant]')) {
        activities.push(
          'Assistant: ' + content.replace('[Assistant] ', '').slice(0, 100),
        );
      } else if (content.startsWith('[Thinking]')) {
        activities.push('Thinking...');
      } else if (content.startsWith('[Result')) {
        activities.push(content.slice(0, 120));
      }
    }
    const state = queue.getState(chatJid);
    const status = state?.active ? 'Running' : 'Idle';
    const recent = activities.slice(-10);
    const msg =
      recent.length > 0
        ? `Agent: ${status}\n\nRecent activity:\n${recent.join('\n')}`
        : `Agent: ${status}\n\nNo recent tool activity.`;
    await channel.sendMessage(chatJid, msg);
    return true;
  }

  if (/^\/status\b/i.test(lastMsg)) {
    consumeCommand();
    const state = queue.getState(chatJid);
    const sid = sessions[group.folder];
    const parts: string[] = [];
    const currentMode = getOperatingMode(group);
    parts.push(`Group: ${group.name} (${group.folder})`);
    parts.push(`Mode: ${currentMode}${group.containerConfig?.mode ? ' (per-group)' : ' (global)'}`);
    parts.push(
      `Agent: ${state?.active ? 'running' : 'idle'}${state?.containerName ? ` (${state.containerName})` : ''}`,
    );
    parts.push(`Session: ${sid ? sid.slice(0, 8) + '...' : 'none'}`);
    if (state?.pendingTasks.length) {
      parts.push(`Queued tasks: ${state.pendingTasks.length}`);
    }
    await channel.sendMessage(chatJid, parts.join('\n'));
    return true;
  }

  if (/^\/help\b/i.test(lastMsg)) {
    consumeCommand();
    await channel.sendMessage(
      chatJid,
      [
        'Commands:',
        '/watch — see what agent is doing right now',
        '/status — agent status (running/idle, session, queue)',
        '/stop — force stop running agent',
        '/sessions — list all sessions',
        '/new — start fresh conversation',
        '/resume [id] — restore previous or specific session',
        '/compact [focus] — compress agent memory',
        '/mode — show/switch mode (compute, intelligence, modeling, mc, auto)',
        '/proceed — continue pipeline to next phase',
        '/help — this message',
      ].join('\n'),
    );
    return true;
  }

  if (/^\/sessions\b/i.test(lastMsg)) {
    const transcriptDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    const lines: string[] = [];
    const currentId = sessions[group.folder];
    // Show profile-scoped sessions for pipeline modes
    const profileSessions: string[] = [];
    for (const profile of ['intelligence', 'modeling', 'compute'] as const) {
      const pKey = sessionKey(group.folder, profile);
      const pSid = sessions[pKey];
      if (pSid) profileSessions.push(`  ${profile}: ${pSid.slice(0, 8)}...`);
    }
    if (profileSessions.length > 0) {
      lines.push('Active profile sessions:');
      lines.push(...profileSessions);
      lines.push('');
    }
    if (fs.existsSync(transcriptDir)) {
      const files = fs
        .readdirSync(transcriptDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const stat = fs.statSync(path.join(transcriptDir, f));
          const id = f.replace('.jsonl', '');
          return { id, size: stat.size, modified: stat.mtime };
        })
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
      for (const s of files) {
        const kb = Math.round(s.size / 1024);
        const time = s.modified.toISOString().slice(0, 16).replace('T', ' ');
        const marker = s.id === currentId ? ' [active]' : '';
        lines.push(`${s.id.slice(0, 8)}  ${time}  ${kb}KB${marker}`);
      }
    }
    consumeCommand();
    const msg =
      lines.length > 0
        ? `Sessions:\n${lines.join('\n')}\n\nUse /resume <id prefix> to switch.`
        : 'No sessions found.';
    await channel.sendMessage(chatJid, msg);
    return true;
  }

  if (/^\/resume\b/i.test(lastMsg)) {
    // /resume requires stopping the running container first
    const state = queue.getState(chatJid);
    if (state?.active && state.process) {
      state.process.kill('SIGTERM');
      if (state.containerName) killContainer(state.containerName);
      logger.info({ group: group.name }, 'Agent stopped for /resume command');
    }

    const arg = lastMsg.replace(/^\/resume\s*/i, '').trim();
    let targetId: string | undefined;

    if (arg) {
      const transcriptDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        '.claude',
        'projects',
        '-workspace-group',
      );
      if (fs.existsSync(transcriptDir)) {
        const match = fs
          .readdirSync(transcriptDir)
          .filter((f) => f.endsWith('.jsonl'))
          .find((f) => f.startsWith(arg));
        if (match) targetId = match.replace('.jsonl', '');
      }
    } else {
      targetId = previousSessions[group.folder];
    }

    if (targetId) {
      sessions[group.folder] = targetId;
      setSession(group.folder, targetId);
      // Restore pipeline notification flags so user isn't re-prompted
      const prevFlags = previousPipelineFlags[group.folder];
      if (prevFlags) {
        if (prevFlags.pipeline_notified) {
          (globalThis as any)[`${group.folder}:pipeline_notified`] = true;
        }
        if (prevFlags.modeling_notified) {
          (globalThis as any)[`${group.folder}:modeling_notified`] = true;
        }
      }
      consumeCommand();
      logger.info(
        { group: group.name, sessionId: targetId },
        'Session restored via /resume',
      );
      await channel.sendMessage(
        chatJid,
        `Session restored (${targetId.slice(0, 8)}...). Agent will continue with that session's history.`,
      );
    } else {
      consumeCommand();
      await channel.sendMessage(
        chatJid,
        'No session found. Use /sessions to list available sessions.',
      );
    }
    return true;
  }

  return false;
}

// ── Startup Banner ──────────────────────────────────────────────────────

/**
 * Interactive module toggle at startup.
 * Uses @inquirer/prompts for proper TTY handling.
 * Only shows in TTY mode (not in systemd/launchd background service).
 * Writes selected modules to .env so they persist across restarts.
 */
async function interactiveModuleToggle(): Promise<void> {
  // Skip in non-interactive environments (systemd, launchd, piped stdin)
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  // Skip if --no-prompt flag is passed
  if (process.argv.includes('--no-prompt')) return;

  const ESC = '\x1b';
  const C = {
    reset: `${ESC}[0m`,
    bold: `${ESC}[1m`,
    dim: `${ESC}[2m`,
    brightGreen: `${ESC}[92m`,
    brightYellow: `${ESC}[93m`,
    brightCyan: `${ESC}[96m`,
    brightWhite: `${ESC}[97m`,
    fg: (n: number) => `${ESC}[38;5;${n}m`,
  };
  const GRAD = [
    196, 197, 198, 199, 200, 164, 128, 92, 56, 57, 63, 69, 75, 81, 45, 39, 33,
    27,
  ];
  const grad = (text: string) =>
    [...text]
      .map((ch, i) => {
        if (ch === ' ') return ch;
        const idx = Math.floor(
          (i / Math.max(text.length - 1, 1)) * (GRAD.length - 1),
        );
        return `${C.fg(GRAD[idx])}${C.bold}${ch}${C.reset}`;
      })
      .join('');

  const W = Math.min(process.stdout.columns || 80, 76);
  const bTop = (t: string) => {
    const s = ` ${t} `;
    const r = Math.max(0, W - 4 - s.length);
    return `  ${C.dim}╭──${C.reset}${C.bold}${C.brightCyan}${s}${C.reset}${C.dim}${'─'.repeat(r)}╮${C.reset}`;
  };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const bLine = (text: string) => {
    const vis = strip(text).length;
    const pad = Math.max(0, W - 4 - vis);
    return `  ${C.dim}│${C.reset} ${text}${' '.repeat(pad)} ${C.dim}│${C.reset}`;
  };
  const bBot = () => `  ${C.dim}╰${'─'.repeat(W - 2)}╯${C.reset}`;
  const bDiv = () => `  ${C.dim}├${'─'.repeat(W - 2)}┤${C.reset}`;

  const modeChoices = [
    {
      key: '1',
      value: 'compute',
      label: 'Compute',
      desc: 'DFT, MD, MLIP calculations',
    },
    {
      key: '2',
      value: 'intelligence',
      label: 'Intelligence',
      desc: 'research direction analysis',
    },
    {
      key: '3',
      value: 'modeling',
      label: 'Modeling',
      desc: 'physical/mathematical modeling',
    },
    {
      key: '4',
      value: 'modeling+compute',
      label: 'Modeling + Compute',
      desc: 'design then execute',
    },
    {
      key: '5',
      value: 'intelligence+compute',
      label: 'Autonomous Research',
      desc: 'full pipeline',
    },
  ];

  console.log(bTop('Select Operating Mode'));
  for (const m of modeChoices) {
    console.log(
      bLine(
        `${C.brightCyan}${m.key}${C.reset}  ${C.bold}${m.label}${C.reset}  ${C.dim}${m.desc}${C.reset}`,
      ),
    );
  }
  console.log(bBot());
  console.log();
  process.stdout.write(`  ${C.dim}Enter 1-5 (default: 1):${C.reset} `);

  const answer = await new Promise<string>((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(data.toString().trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });

  const picked = modeChoices.find((m) => m.key === answer) || modeChoices[0];
  const mode = picked.value;
  console.log(`  ${C.brightGreen}✔${C.reset} ${picked.label}`);
  console.log();

  try {
    // Write mode to .env
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf-8');
    } catch {
      /* no .env yet */
    }

    const enableIntel =
      mode === 'intelligence' || mode === 'intelligence+compute';
    const enableModeling =
      mode === 'modeling' ||
      mode === 'modeling+compute' ||
      mode === 'intelligence+compute';

    if (/^INTELLIGENCE_MODULE=/m.test(envContent)) {
      envContent = envContent.replace(
        /^INTELLIGENCE_MODULE=\w*/m,
        `INTELLIGENCE_MODULE=${enableIntel || enableModeling}`,
      );
    } else {
      envContent += `\nINTELLIGENCE_MODULE=${enableIntel || enableModeling}\n`;
    }

    if (/^INTELLIGENCE_MODE=/m.test(envContent)) {
      envContent = envContent.replace(
        /^INTELLIGENCE_MODE=\S*/m,
        `INTELLIGENCE_MODE=${mode}`,
      );
    } else {
      envContent += `INTELLIGENCE_MODE=${mode}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    (globalThis as any).__INTELLIGENCE_MODULE_OVERRIDE =
      enableIntel || enableModeling;

    const labels: Record<string, string> = {
      compute: `${C.dim}Compute${C.reset}`,
      intelligence: `${C.brightCyan}Intelligence${C.reset}`,
      modeling: `${C.brightCyan}Modeling${C.reset}`,
      'modeling+compute': `${C.brightGreen}Modeling → Compute${C.reset}`,
      'intelligence+compute': `${C.brightGreen}Autonomous Research${C.reset}`,
    };
    console.log(
      `  ${C.brightGreen}✔${C.reset}  Mode: ${labels[mode] || mode}  ${C.dim}(saved to .env)${C.reset}`,
    );
    console.log();
  } catch {
    // User pressed Ctrl+C or prompt was interrupted — continue without changes
  }
}

function printStartupBanner(): void {
  const ESC = '\x1b';
  const C = {
    reset: `${ESC}[0m`,
    bold: `${ESC}[1m`,
    dim: `${ESC}[2m`,
    underline: `${ESC}[4m`,
    green: `${ESC}[32m`,
    yellow: `${ESC}[33m`,
    cyan: `${ESC}[36m`,
    brightGreen: `${ESC}[92m`,
    brightYellow: `${ESC}[93m`,
    brightCyan: `${ESC}[96m`,
    brightWhite: `${ESC}[97m`,
    fg: (n: number) => `${ESC}[38;5;${n}m`,
  };
  const GRAD = [
    196, 197, 198, 199, 200, 164, 128, 92, 56, 57, 63, 69, 75, 81, 45, 39, 33,
    27,
  ];
  const W = Math.min(process.stdout.columns || 80, 76);

  const grad = (text: string) =>
    [...text]
      .map((ch, i) => {
        if (ch === ' ') return ch;
        const idx = Math.floor(
          (i / Math.max(text.length - 1, 1)) * (GRAD.length - 1),
        );
        return `${C.fg(GRAD[idx])}${C.bold}${ch}${C.reset}`;
      })
      .join('');

  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const bTop = (t?: string) => {
    if (t) {
      const s = ` ${t} `;
      const r = Math.max(0, W - 4 - s.length);
      return `  ${C.dim}╭──${C.reset}${C.bold}${C.brightCyan}${s}${C.reset}${C.dim}${'─'.repeat(r)}╮${C.reset}`;
    }
    return `  ${C.dim}╭${'─'.repeat(W - 2)}╮${C.reset}`;
  };
  const bLine = (text: string) => {
    const vis = strip(text).length;
    const pad = Math.max(0, W - 4 - vis);
    return `  ${C.dim}│${C.reset} ${text}${' '.repeat(pad)} ${C.dim}│${C.reset}`;
  };
  const bDiv = () => `  ${C.dim}├${'─'.repeat(W - 2)}┤${C.reset}`;
  const bBot = () => `  ${C.dim}╰${'─'.repeat(W - 2)}╯${C.reset}`;
  const bEmpty = () => `  ${C.dim}│${' '.repeat(W - 2)}│${C.reset}`;

  const logo = [
    '  ███╗   ███╗ █████╗ ████████╗ ██████╗██╗      █████╗ ██╗    ██╗',
    '  ████╗ ████║██╔══██╗╚══██╔══╝██╔════╝██║     ██╔══██╗██║    ██║',
    '  ██╔████╔██║███████║   ██║   ██║     ██║     ███████║██║ █╗ ██║',
    '  ██║╚██╔╝██║██╔══██║   ██║   ██║     ██║     ██╔══██║██║███╗██║',
    '  ██║ ╚═╝ ██║██║  ██║   ██║   ╚██████╗███████╗██║  ██║╚███╔███╔╝',
    '  ╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ',
  ];

  console.log();
  for (const line of logo) console.log(grad(line));
  console.log();

  // Channel status
  console.log(bTop('Channels'));
  for (const ch of channels) {
    const name = ch.constructor.name.replace('Channel', '');
    console.log(
      bLine(
        `${C.brightGreen}✔${C.reset}  ${C.bold}${name}${C.reset} ${C.dim}connected${C.reset}`,
      ),
    );
  }
  // Show skipped channels
  for (const chName of getRegisteredChannelNames()) {
    if (
      !channels.find((ch) =>
        ch.constructor.name.toLowerCase().includes(chName.toLowerCase()),
      )
    ) {
      console.log(
        bLine(
          `${C.brightYellow}⚠${C.reset}  ${C.bold}${chName}${C.reset} ${C.dim}credentials missing${C.reset}`,
        ),
      );
    }
  }
  console.log(bDiv());
  const groupCount = Object.keys(registeredGroups).length;
  console.log(
    bLine(
      `${C.brightCyan}Groups:${C.reset} ${groupCount}  ${C.dim}│${C.reset}  ${C.brightCyan}Trigger:${C.reset} @${ASSISTANT_NAME}`,
    ),
  );

  // Modules status
  console.log(bDiv());
  console.log(bLine(`${C.bold}${C.brightWhite}Modules${C.reset}`));
  const currentMode = getOperatingMode();
  const modeIcons: Record<string, string> = {
    compute: `${C.dim}○ Compute${C.reset}`,
    intelligence: `${C.brightCyan}● Intelligence${C.reset}`,
    modeling: `${C.brightCyan}● Modeling${C.reset}`,
    'modeling+compute': `${C.brightGreen}● Modeling → Compute${C.reset}`,
    'intelligence+compute': `${C.brightGreen}● Autonomous Research${C.reset} ${C.dim}(${PIPELINE_AUTO ? 'auto' : 'manual'})${C.reset}`,
  };
  const intStatus = modeIcons[currentMode] || modeIcons['compute'];
  console.log(bLine(intStatus));

  console.log(bDiv());
  console.log(
    bLine(
      `${C.bold}/watch${C.reset}   ${C.dim}monitor${C.reset}  ${C.bold}/status${C.reset}  ${C.dim}info${C.reset}  ${C.bold}/stop${C.reset}  ${C.dim}halt${C.reset}  ${C.bold}/help${C.reset}  ${C.dim}all cmds${C.reset}`,
    ),
  );
  console.log(bBot());
  console.log();
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`MatClaw running (trigger: @${ASSISTANT_NAME})`);
  printStartupBanner();

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;
          const activeThreadId =
            group.folder === WEB_CHAT_FOLDER
              ? getActiveWebChatThreadId()
              : undefined;
          const cursorKey = getAgentCursorKey(chatJid, activeThreadId);
          const scopedGroupMessages =
            group.folder === WEB_CHAT_FOLDER
              ? groupMessages.filter(
                  (msg) => (msg.thread_id || activeThreadId) === activeThreadId,
                )
              : groupMessages;
          if (scopedGroupMessages.length === 0) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Intercept control commands before piping to running container.
          // Commands like /stop, /new, /watch work even while agent is active.
          const handled = await handleControlCommand(
            chatJid,
            group,
            channel,
            scopedGroupMessages,
          );
          if (handled) continue;

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = scopedGroupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[cursorKey] || '',
            ASSISTANT_NAME,
            activeThreadId,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : scopedGroupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[cursorKey] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const activeThreadId =
      group.folder === WEB_CHAT_FOLDER ? getActiveWebChatThreadId() : undefined;
    const cursorKey = getAgentCursorKey(chatJid, activeThreadId);
    const sinceTimestamp = lastAgentTimestamp[cursorKey] || '';
    const pending = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
      activeThreadId,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  ensureImageAvailable();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Interactive module toggle (only in TTY mode, skips in background services)
  await interactiveModuleToggle();

  ensureContainerSystemRunning();

  // Start credential proxy before any containers spawn
  await startCredentialProxy(CREDENTIAL_PROXY_PORT).catch((err) => {
    logger.warn(
      { err },
      'Credential proxy failed to start — containers will use stdin secrets as fallback',
    );
  });

  initDatabase();
  logger.info('Database initialized');
  loadState();
  syncWebChatRuntimeSession(getActiveWebChatThreadId());

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await queue.shutdown(10000);
      for (const ch of channels) {
        await ch.disconnect().catch(() => {});
      }
    } catch (err) {
      logger.warn({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Start monitoring dashboard (with channelOpts for web chat)
  startDashboard(channelOpts, {
    listSessions: () => listWebChatThreads(),
    getActiveThreadId: () => getActiveWebChatThreadId(),
    createSession: () => {
      const thread = createWebChatThread();
      activateWebChatThread(thread.id);
      return getWebChatThread(thread.id)!;
    },
    switchSession: (threadId: string) => {
      activateWebChatThread(threadId);
      return getWebChatThread(threadId);
    },
    renameSession: (threadId: string, title: string) =>
      renameWebChatThread(threadId, title),
    deleteSession: (threadId: string) =>
      deleteAndReplaceWebChatThread(threadId),
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start MatClaw');
    process.exit(1);
  });
}
