/**
 * Claude Agent SDK engine for MatClaw.
 * Wraps the @anthropic-ai/claude-agent-sdk query() function.
 */

import fs from 'fs';
import path from 'path';
import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
  type SdkBeta,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentEngine, EngineContext, QueryResult } from './interface.js';
import type { CalcReport } from '../schemas/matclaw_v2.js';

// ── SDK message type for MessageStream ──

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// ── Push-based async iterable for streaming user messages to the SDK ──

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Session archiving helpers ──

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    return (
      index.entries.find((e) => e.sessionId === sessionId)?.summary ?? null
    );
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const t = new Date();
  return `conversation-${t.getHours().toString().padStart(2, '0')}${t.getMinutes().toString().padStart(2, '0')}`;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        if (textParts.join(''))
          messages.push({ role: 'assistant', content: textParts.join('') });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const fmt = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  const lines: string[] = [
    `# ${title || 'Conversation'}`,
    '',
    `Archived: ${fmt(now)}`,
    '',
    '---',
    '',
  ];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

// ── Hooks ──

const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input: unknown) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};
      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      fs.writeFileSync(
        path.join(conversationsDir, `${date}-${name}.md`),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
    } catch {
      /* non-fatal */
    }
    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input: unknown) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const maxSleepSeconds = parseInt(
      process.env['MATCLAW_INTERACTIVE_MAX_SLEEP_SECONDS'] || '120',
      10,
    );
    const longSleep = findLongSleep(command, maxSleepSeconds);
    if (longSleep !== null) {
      return {
        decision: 'block',
        reason:
          `Blocked foreground sleep of ${longSleep}s. ` +
          'Do not monitor HPC jobs with long sleep commands inside the interactive MatClaw turn. ' +
          'Use mcp__matclaw__schedule_task or a short status check instead so the user can steer the agent.',
      };
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function findLongSleep(command: string, maxSeconds: number): number | null {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return null;

  const sleepPattern =
    /(?:^|[\s;&|()])sleep\s+([0-9]+)([smhd]?)(?=$|[\s;&|()'"])/gi;
  let match: RegExpExecArray | null;
  while ((match = sleepPattern.exec(command)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multiplier =
      unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    const seconds = value * multiplier;
    if (seconds > maxSeconds) return seconds;
  }

  return null;
}

// ── Claude Engine ──

const IPC_POLL_MS = 500;
const PROGRESS_MAX_CHARS = 500;

function compactProgressText(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROGRESS_MAX_CHARS);
}

function summarizeToolInput(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return name || 'tool';
  const obj = input as Record<string, unknown>;
  const description = obj['description'];
  if (typeof description === 'string' && description.trim()) {
    return description.trim();
  }
  const command = obj['command'];
  if (typeof command === 'string' && command.trim()) {
    return command.trim().split('\n')[0].slice(0, 220);
  }
  return name || 'tool';
}

function emitProgress(
  ctx: EngineContext,
  progressType: 'assistant' | 'tool' | 'heartbeat',
  text: string,
): void {
  const progress = compactProgressText(text);
  if (!progress) return;
  ctx.writeOutput({
    status: 'success',
    result: null,
    kind: 'progress',
    progressType,
    progress,
  });
}

// ── P4.2 onCalcReport — TensorZero feedback for matclaw_calc_converged ──
//
// Fires asynchronously (fire-and-forget) from the tool_result handler in the
// main query loop whenever the agent emits a CalcReport via an MCP tool. The
// hook posts a single feedback datum to TENSORZERO_GATEWAY_URL/feedback with
// value 1.0 for a passing ConvergenceVerdict and 0.0 otherwise. Tags carry
// material_class / calc_type / code / functional so TZ's track_and_stop can
// later learn which compute strategies converge on which material classes.
//
// Silent no-op when TENSORZERO_GATEWAY_URL is unset so non-TZ deployments
// (local dev, CI) still work. Never throws — all errors are logged via the
// EngineContext.
async function onCalcReport(
  report: CalcReport,
  ctx: EngineContext,
  inferenceId?: string,
): Promise<void> {
  const gatewayUrl =
    ctx.sdkEnv['TENSORZERO_GATEWAY_URL'] ?? process.env['TENSORZERO_GATEWAY_URL'];
  if (!gatewayUrl) {
    return; // no TZ configured; silent no-op
  }
  const value = report.verdict?.verdict === 'pass' ? 1.0 : 0.0;
  // Tier-1 decision (2026-05-29): use the upstream Claude assistant inference
  // UUID that decided to launch this calc — the SDK's `assistant.uuid` on the
  // tool_use parent message. Falls back to report.calc_id only when the
  // tool_use → inference lookup didn't populate (e.g. a CalcReport surfaced
  // outside the standard tool_result path). This is what lets TZ's
  // track_and_stop correlate calc outcomes back to specific prompt variants
  // in the agent's behaviour rather than aggregating across all calc_ids.
  const resolvedInferenceId = inferenceId ?? report.calc_id;
  try {
    const response = await fetch(`${gatewayUrl}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metric_name: 'matclaw_calc_converged',
        value,
        inference_id: resolvedInferenceId,
        tags: {
          material_class: report.material.material_class ?? 'unknown',
          calc_type: report.calc_type,
          code: report.code,
          functional: report.functional ?? 'unknown',
          calc_id: report.calc_id,
          inference_id_source: inferenceId ? 'assistant_uuid' : 'calc_id_fallback',
        },
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      ctx.log(
        `onCalcReport TZ feedback rejected: HTTP ${response.status} ${body.slice(0, 500)}`,
      );
    }
  } catch (err) {
    // Log but don't throw — TZ feedback is best-effort.
    ctx.log(
      `onCalcReport TZ feedback failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Heuristic shape-check for CalcReport on tool_result content. The
// pydantic2ts-generated CalcReport requires material/calc_type/code at top
// level, so structural presence is a sufficient discriminator from other
// tool_result payloads (string transcripts, error dicts, etc.).
function isCalcReportShape(value: unknown): value is CalcReport {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['calc_id'] === 'string' &&
    typeof obj['calc_type'] === 'string' &&
    typeof obj['code'] === 'string' &&
    !!obj['material'] &&
    typeof obj['material'] === 'object'
  );
}

// Pull a candidate object out of tool_result.content, which the Anthropic
// SDK can deliver as:
//   • a raw object (structured-outputs beta returning the parsed value)
//   • a string (JSON-serialized)
//   • an array of content blocks (the typical MCP shape; concat the .text
//     fields and JSON.parse). Returns null on any parse failure.
function extractCalcReportCandidate(content: unknown): unknown | null {
  if (!content) return null;
  if (typeof content === 'object' && !Array.isArray(content)) {
    return content;
  }
  let raw: string | null = null;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .map((b) => {
        if (b && typeof b === 'object') {
          const text = (b as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export class ClaudeEngine implements AgentEngine {
  readonly name = 'claude';

  async runQuery(
    prompt: string,
    sessionId: string | undefined,
    ctx: EngineContext,
    resumeAt?: string,
  ): Promise<QueryResult> {
    const stream = new MessageStream();
    stream.push(prompt);

    // The Query handle is assigned below right before the for-await loop;
    // pollIpc captures it by closure so interrupts can call q.interrupt().
    let q: ReturnType<typeof query> | null = null;

    // Poll IPC for follow-up messages, interrupts, and _close sentinel during
    // the query. Three signal classes:
    //   _close          → end stream, exit the for-await loop
    //   interrupt files → call q.interrupt() (async, fire-and-forget) and push
    //                     follow-up text into the stream; the SDK will resume
    //                     on the next turn boundary with the new instruction
    //   message files   → push directly into the stream as additional user
    //                     turns (consumed at the next turn boundary)
    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (ctx.shouldClose()) {
        ctx.log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      ctx.refreshSdkEnv(ctx.sdkEnv);

      const interrupts = ctx.drainIpcInterrupts
        ? ctx.drainIpcInterrupts()
        : [];
      if (interrupts.length > 0) {
        ctx.log(
          `Interrupt signal received (${interrupts.length} pending); calling query.interrupt()`,
        );
        if (q) {
          q.interrupt().then(
            () => ctx.log('query.interrupt() acknowledged'),
            (err: unknown) =>
              ctx.log(
                `query.interrupt() failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
          );
        } else {
          ctx.log('Interrupt arrived before query handle was bound; ignoring');
        }
        clearAllToolHeartbeats('interrupted');
        for (const text of interrupts) {
          if (text) {
            ctx.log(
              `Piping post-interrupt instruction into stream (${text.length} chars)`,
            );
            stream.push(text);
          }
        }
      }

      const messages = ctx.drainIpcInput();
      for (const text of messages) {
        ctx.log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpc, IPC_POLL_MS);
    };
    setTimeout(pollIpc, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    // Per Tier-1 decision (2026-05-29): correlate every tool_use_id to the
    // assistant-message UUID that emitted it, so onCalcReport can later
    // resolve the upstream Claude inference for TZ feedback. Map is per
    // query() invocation — naturally bounded by the agent's turn count.
    const toolUseToInferenceId = new Map<string, string>();
    let messageCount = 0;
    let resultCount = 0;

    // Per-query telemetry: track in-flight tool calls so we can (a) emit a
    // "still running …Ns" heartbeat every HEARTBEAT_INTERVAL_MS to keep the
    // UI alive during long bash/MCP calls, and (b) record per-call duration
    // + outcome to a JSONL for later skill-violation analysis. The JSONL
    // lives on NFS via the /workspace/group mount, so the host can `tail` /
    // `jq` it without entering the container.
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const TELEMETRY_PATH = '/workspace/group/.matclaw/tool-timings.jsonl';
    interface ToolCallState {
      name: string;
      inputSummary: string;
      startTime: number;
      heartbeat: NodeJS.Timeout;
    }
    const toolCalls = new Map<string, ToolCallState>();

    const startToolHeartbeat = (
      toolUseId: string,
      name: string,
      input: unknown,
    ): void => {
      const startTime = Date.now();
      const inputSummary = summarizeToolInput(name, input);
      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        emitProgress(
          ctx,
          'heartbeat',
          `Still running ${name}: ${inputSummary} (${elapsedSec}s elapsed)`,
        );
      }, HEARTBEAT_INTERVAL_MS);
      toolCalls.set(toolUseId, { name, inputSummary, startTime, heartbeat });
    };

    const stopToolHeartbeat = (
      toolUseId: string,
      outcome: 'completed' | 'interrupted',
    ): void => {
      const entry = toolCalls.get(toolUseId);
      if (!entry) return;
      clearInterval(entry.heartbeat);
      toolCalls.delete(toolUseId);
      const durationMs = Date.now() - entry.startTime;
      const mcpMatch = entry.name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
      const mcpServer = mcpMatch ? mcpMatch[1] : null;
      const record = {
        ts: new Date().toISOString(),
        tool_use_id: toolUseId,
        tool_name: entry.name,
        mcp_server: mcpServer, // P5.1 — namespace extracted from tool_name; null for native tools
        duration_ms: durationMs,
        input_summary: entry.inputSummary.slice(0, 220),
        outcome,
        session_id: newSessionId || null,
        group_folder: ctx.groupFolder,
      };
      try {
        fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
        fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(record) + '\n');
      } catch (err) {
        ctx.log(
          `Failed to write tool timing telemetry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const clearAllToolHeartbeats = (
      outcome: 'completed' | 'interrupted',
    ): void => {
      for (const toolUseId of Array.from(toolCalls.keys())) {
        stopToolHeartbeat(toolUseId, outcome);
      }
    };

    // Load global CLAUDE.md
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (!ctx.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    // Discover additional directories
    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
      }
    }
    if (extraDirs.length > 0)
      ctx.log(`Additional directories: ${extraDirs.join(', ')}`);

    // Set model if AGENT_MODEL is configured (maps to CLAUDE_CODE_MODEL for SDK).
    // Read from sdkEnv first (refreshed via IPC) so model can switch mid-session,
    // then fall back to container env var set at startup.
    const agentModel = ctx.sdkEnv['AGENT_MODEL'] || process.env['AGENT_MODEL'];
    if (agentModel) {
      ctx.sdkEnv['CLAUDE_CODE_MODEL'] = agentModel;
      ctx.log(`Using model: ${agentModel}`);
    } else {
      delete ctx.sdkEnv['CLAUDE_CODE_MODEL'];
    }

    // ── Anthropic-Beta headers ─────────────────────────────────────
    //
    // P0.3 (beefcake-qq322): enable the Structured Outputs beta so
    // tools that declare Pydantic-derived JSON schemas (Phase 2 MCP
    // wrappers — CalcReport, ConvergenceVerdict, etc.) get strict
    // schema enforcement on tool-result roundtrips.
    // Spec: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
    //
    // SDK 0.2.34 declares `SdkBeta = 'context-1m-2025-08-07'` only, so
    // the new beta identifier needs a cast until the SDK union widens
    // upstream. The underlying `@anthropic-ai/sdk` forwards the array
    // verbatim as the `anthropic-beta` HTTP header (comma-joined), so
    // the runtime behavior is correct; only the typecheck needs help.
    // TODO(P0.3): drop the cast once claude-agent-sdk publishes a
    //             version with 'structured-outputs-2025-11-13' in
    //             SdkBeta.
    const betas: SdkBeta[] = [
      'structured-outputs-2025-11-13' as unknown as SdkBeta,
    ];

    const envValue = (key: string): string => {
      return ctx.sdkEnv[key] ?? process.env[key] ?? '';
    };
    const endpointValue = (key: string, fallback = ''): string => {
      const raw = envValue(key);
      const endpoint = raw || fallback;
      // These MCP servers use streamable-HTTP (`type: 'http'`), served at an
      // explicit path (e.g. graphiti's "/mcp/"). Respect a configured path
      // verbatim. Only bare host[:port] endpoints get the legacy "/sse"
      // suffix (SSE-transport fallback). Previously this unconditionally
      // appended "/sse", rewriting ".../mcp/" -> ".../mcp/sse" (404) and
      // silently breaking the graphiti memory layer + onCalcReport TZ hook.
      let parsed: URL | null = null;
      try {
        parsed = new URL(endpoint);
      } catch {
        parsed = null;
      }
      const hasExplicitPath =
        parsed !== null && parsed.pathname !== '' && parsed.pathname !== '/';
      if (hasExplicitPath || endpoint.endsWith('/sse')) {
        return endpoint;
      }
      return `${endpoint.replace(/\/$/, '')}/sse`;
    };

    // Register an optional streamable-HTTP MCP drop-in ONLY when its endpoint is
    // explicitly configured. Without this guard an undeployed service falls back
    // to a hard-coded default host, so every agent run attempts a dead
    // connection (degraded startup + phantom tools the model thinks it has).
    // Setting <NAME>_ENDPOINT auto-enables the server — keeps optional
    // integrations portable across deployments (a cluster without a given
    // service simply omits its env vars).
    const httpMcpIfConfigured = (
      name: string,
      endpointKey: string,
      apiKeyKey: string,
    ): Record<
      string,
      { type: 'http'; url: string; headers: Record<string, string> }
    > => {
      if (!envValue(endpointKey)) return {};
      return {
        [name]: {
          type: 'http',
          // endpointKey is guaranteed present by the guard above, so no fallback.
          url: endpointValue(endpointKey),
          headers: { 'X-API-Key': envValue(apiKeyKey) },
        },
      };
    };

    q = query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        betas,
        systemPrompt: globalClaudeMd
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: globalClaudeMd,
            }
          : undefined,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__matclaw__*',
          'mcp__gmail__*',
          // Phase 1 drop-ins
          'mcp__mp__*',
          'mcp__graphiti__*',
          'mcp__arxiv__*',
          // Phase 2 wrappers
          'mcp__pymatgen_inputset__*',
          'mcp__pymatgen_validation__*',
          'mcp__atomate2__*',
          'mcp__jobflow_remote__*',
          'mcp__mlip__*',
          'mcp__phonon_gw__*',
        ],
        env: ctx.sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          matclaw: {
            command: 'node',
            args: [ctx.mcpServerPath],
            env: {
              MATCLAW_CHAT_JID: ctx.chatJid,
              MATCLAW_GROUP_FOLDER: ctx.groupFolder,
              MATCLAW_IS_MAIN: ctx.isMain ? '1' : '0',
            },
          },
          gmail: {
            command: 'npx',
            args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
          },
          // Phase 1 drop-ins
          mp: {
            // P1.6 audit landed: Docker invocation, image digest-pinned.
            command: 'docker',
            args: [
              'run',
              '--rm',
              '-i',
              '-e',
              `MP_API_KEY=${envValue('MP_API_KEY')}`,
              'benedict2002/materials-project-mcp@sha256:b77c75cd6acb34905c940fdd0a732f0cb62d8957d0f9f964d708dad6f5fd49fd',
            ],
          },
          ...httpMcpIfConfigured(
            'graphiti',
            'GRAPHITI_ENDPOINT',
            'GRAPHITI_API_KEY',
          ),
          arxiv: {
            command: 'uvx',
            args: ['arxiv-mcp-server@0.5.0'],
          },
          // Phase 2 thin wrappers (registered together since all 6 are done)
          pymatgen_inputset: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.pymatgen_inputset_mcp'],
          },
          pymatgen_validation: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.pymatgen_validation_mcp'],
          },
          atomate2: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.atomate2_maker_mcp'],
            env: { JOBFLOW_CONFIG_FILE: '/workspace/group/.jobflow/jobflow.yaml' },
          },
          jobflow_remote: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.jobflow_remote_mcp'],
            env: { JF_REMOTE_PROJECT: 'matclaw' },
          },
          mlip: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.mlip_unified_mcp'],
            env: { MLIP_MODEL_CACHE: '/cluster/shared/mlip-models' },
          },
          phonon_gw: {
            command: 'python',
            args: ['-m', 'matclaw_wrappers.phonopy_yambopy_mcp'],
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(ctx.assistantName)] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
        },
      },
    });

    for await (const message of q) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      ctx.log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant') {
        if ('uuid' in message)
          lastAssistantUuid = (message as { uuid: string }).uuid;
        const msg = message as {
          message?: {
            content?: Array<{
              type: string;
              text?: string;
              thinking?: string;
              name?: string;
              input?: unknown;
              id?: string;
            }>;
          };
        };
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'thinking' && block.thinking)
              ctx.log(`[Thinking] ${block.thinking.slice(0, 2000)}`);
            else if (block.type === 'text' && block.text) {
              ctx.log(`[Assistant] ${block.text.slice(0, 2000)}`);
              emitProgress(ctx, 'assistant', block.text);
            } else if (block.type === 'tool_use') {
              ctx.log(`[ToolCall] ${block.name} (id: ${block.id})`);
              ctx.log(
                `[ToolInput] ${JSON.stringify(block.input || {}).slice(0, 3000)}`,
              );
              emitProgress(
                ctx,
                'tool',
                `Using ${block.name || 'tool'}: ${summarizeToolInput(block.name, block.input)}`,
              );
              if (block.id && block.name) {
                startToolHeartbeat(block.id, block.name, block.input);
              }
              // Pin the upstream assistant inference UUID against this
              // tool_use_id so onCalcReport can later attribute the
              // resulting CalcReport back to the inference that planned it.
              if (block.id && lastAssistantUuid) {
                toolUseToInferenceId.set(block.id, lastAssistantUuid);
              }
            }
          }
        }
      }

      if (message.type === 'user') {
        const msg = message as {
          message?: {
            content?: Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
            }>;
          };
        };
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              if (block.tool_use_id) {
                stopToolHeartbeat(block.tool_use_id, 'completed');
              }
              const resultStr =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content || '');
              ctx.log(
                `[ToolResult] (id: ${block.tool_use_id}) ${resultStr.slice(0, 3000)}`,
              );

              // P4.2: detect CalcReport shape in tool_result content and emit
              // TZ feedback. Fire-and-forget — never blocks the agent loop.
              // The content can be a raw object (structured outputs beta),
              // a string (JSON serialized), or an array of text content
              // blocks (the common MCP shape). Try all three.
              const candidate = extractCalcReportCandidate(block.content);
              if (candidate && isCalcReportShape(candidate)) {
                const inferenceId = block.tool_use_id
                  ? toolUseToInferenceId.get(block.tool_use_id)
                  : undefined;
                onCalcReport(candidate, ctx, inferenceId).catch(() => {
                  /* logged inside onCalcReport */
                });
              }
            }
          }
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        ctx.log(`Session initialized: ${newSessionId}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        ctx.log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        ctx.log(
          `[Result #${resultCount}] subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 500)}` : ''}`,
        );
        ctx.writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
        });
      }
    }

    ipcPolling = false;
    // Any tool calls still in-flight at loop exit (close sentinel, stream
    // end, or interrupted query) get their heartbeats cleared and a final
    // telemetry record with outcome:'interrupted'.
    clearAllToolHeartbeats(closedDuringQuery ? 'interrupted' : 'completed');
    ctx.log(
      `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
    );
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }
}
