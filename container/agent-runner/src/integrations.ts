/**
 * Integration registry — the single source of truth for the MCP integrations
 * the agent exposes.
 *
 * Before this module, the same set of integrations was described in three
 * places that had to stay in lockstep (and drifted):
 *   - the `mcpServers` object literal in engines/claude.ts
 *   - the `allowedTools` `mcp__<name>__*` globs in engines/claude.ts
 *   - `MANAGED_SDK_ENV_KEYS` in index.ts
 *
 * Now each integration is one `IntegrationSpec` row, and the catalog,
 * the tool globs, and the managed-env manifest are all DERIVED by
 * `buildAgentConfig` in a single pass — they cannot drift apart.
 *
 * Design (see CONTEXT.md): a closed tagged-union `Transport` (exhaustively
 * type-checked), terse `cmd`/`http`/`docker` smart-constructors for the common
 * shapes, and a pure builder whose only impurity (env access) is injected via
 * `EnvAccess` so the whole thing is unit-testable without the Agent SDK.
 */

// ---------------------------------------------------------------------------
// Env seam — the single injected dependency (mirrors the helpers in claude.ts)
// ---------------------------------------------------------------------------

export interface EnvAccess {
  /** `ctx.sdkEnv[key] ?? process.env[key] ?? ''` (the existing envValue). */
  value(key: string): string;
  /** Applies the `/sse` path logic for bare host endpoints (existing endpointValue). */
  endpoint(key: string, fallback?: string): string;
}

// ---------------------------------------------------------------------------
// Transport — closed tagged union (add an arm here to add a transport kind)
// ---------------------------------------------------------------------------

export type Transport =
  | {
      kind: 'command';
      command: string;
      args: string[];
      /** Literal env passed to the process (e.g. per-run ctx values, config paths). */
      staticEnv?: Record<string, string>;
    }
  | {
      kind: 'docker';
      image: string;
      /** Secret env keys spliced in as `-e KEY=<value>` (read via EnvAccess at build). */
      secretEnvKeys?: string[];
      /** Extra `docker run` args inserted before the image. */
      runArgs?: string[];
    }
  | {
      kind: 'http';
      endpointKey: string;
      apiKeyKey?: string;
      /** Header carrying the API key; defaults to `X-API-Key`. */
      headerName?: string;
    };

export interface IntegrationSpec {
  /** MCP server name; also drives the `mcp__<name>__*` allowedTools glob. */
  name: string;
  transport: Transport;
  /**
   * Env keys this integration needs passed/refreshed (its secrets + endpoints).
   * Collected into the managed-env manifest whether or not the server is live
   * this run, so re-supplying an endpoint at runtime activates it.
   */
  envKeys?: readonly string[];
}

/** Structural shape of the Agent SDK's `mcpServers` value — never import the SDK. */
export type McpServerConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface AgentMcpConfig {
  /** Ready for query({ options: { mcpServers } }); gated-out http servers omitted. */
  mcpServers: Record<string, McpServerConfig>;
  /** `mcp__<name>__*` for each LIVE server — mirrors mcpServers exactly. */
  allowedTools: string[];
  /** De-duped union of base + every selected spec's envKeys (gated or not). */
  managedEnvKeys: string[];
}

export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

// ---------------------------------------------------------------------------
// Base (non-integration) agent env — auth, model, TZ feedback, ASTA (via CLI).
// These are not MCP integrations, so they live here rather than in a spec.
// ---------------------------------------------------------------------------

export const BASE_ENV_KEYS: readonly string[] = [
  // Engine / model selection
  'AGENT_MODEL',
  'CODEX_MODEL',
  // Anthropic (Claude Code) auth
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  // Codex / OpenAI auth
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  // Misc cloud
  'GOOGLE_API_KEY',
  // TensorZero feedback (onCalcReport)
  'TENSORZERO_GATEWAY_URL',
  // ASTA (used via the mounted asta-cli, not an MCP server)
  'ASTA_TOKEN',
  'ASTA_API_KEY',
  'ASTA_A2A_API_KEY',
  'ASTA_GATEWAY_URL',
];

// ---------------------------------------------------------------------------
// Smart constructors — the terse common shapes (③). docker stays explicit.
// ---------------------------------------------------------------------------

/** A stdio/command MCP (node / npx / uvx / python). No secrets in args. */
export function cmd(
  name: string,
  command: string,
  args: string[],
  opts: { staticEnv?: Record<string, string>; envKeys?: readonly string[] } = {},
): IntegrationSpec {
  return {
    name,
    transport: { kind: 'command', command, args, staticEnv: opts.staticEnv },
    envKeys: opts.envKeys,
  };
}

/**
 * An http MCP, registered ONLY when its endpoint env is set. `envKeys` is
 * auto-populated to [endpointKey, apiKeyKey] so the manifest stays correct.
 */
export function http(
  name: string,
  endpointKey: string,
  apiKeyKey?: string,
  opts: { headerName?: string } = {},
): IntegrationSpec {
  const envKeys = apiKeyKey ? [endpointKey, apiKeyKey] : [endpointKey];
  return {
    name,
    transport: { kind: 'http', endpointKey, apiKeyKey, headerName: opts.headerName },
    envKeys,
  };
}

/** A docker-run MCP. Secret env keys are spliced as `-e KEY=<value>` at build. */
export function docker(
  name: string,
  image: string,
  opts: { secretEnvKeys?: string[]; runArgs?: string[] } = {},
): IntegrationSpec {
  return {
    name,
    transport: { kind: 'docker', image, secretEnvKeys: opts.secretEnvKeys, runArgs: opts.runArgs },
    envKeys: opts.secretEnvKeys,
  };
}

// ---------------------------------------------------------------------------
// Per-transport server construction (behind the seam)
// ---------------------------------------------------------------------------

/** Returns the SDK config, or null to omit (an http server whose endpoint is unset). */
function buildServer(t: Transport, env: EnvAccess): McpServerConfig | null {
  switch (t.kind) {
    case 'command':
      return { command: t.command, args: t.args, env: t.staticEnv };
    case 'docker': {
      const secretFlags = (t.secretEnvKeys ?? []).flatMap((k) => [
        '-e',
        `${k}=${env.value(k)}`,
      ]);
      return {
        command: 'docker',
        args: ['run', '--rm', '-i', ...secretFlags, ...(t.runArgs ?? []), t.image],
      };
    }
    case 'http': {
      if (!env.value(t.endpointKey)) return null; // not deployed → skip cleanly
      return {
        type: 'http',
        url: env.endpoint(t.endpointKey),
        headers: { [t.headerName ?? 'X-API-Key']: env.value(t.apiKeyKey ?? '') },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The builder — one pass derives the three lockstep artifacts
// ---------------------------------------------------------------------------

export function buildAgentConfig(
  specs: readonly IntegrationSpec[],
  env: EnvAccess,
  opts: { select?: readonly string[]; baseEnvKeys?: readonly string[] } = {},
): AgentMcpConfig {
  const selected = opts.select
    ? specs.filter((s) => opts.select!.includes(s.name))
    : specs;

  // Duplicate names would collide as object keys / tool globs — fail loud.
  const seen = new Set<string>();
  for (const s of selected) {
    if (!s.name) throw new IntegrationConfigError('integration with empty name');
    if (seen.has(s.name)) throw new IntegrationConfigError(`duplicate integration: ${s.name}`);
    seen.add(s.name);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedTools: string[] = [];
  const envKeys = new Set<string>(opts.baseEnvKeys ?? []);

  for (const spec of selected) {
    // Env keys are managed whether or not the server is live this run.
    for (const k of spec.envKeys ?? []) envKeys.add(k);

    const server = buildServer(spec.transport, env);
    if (server === null) continue; // gated-out http: no server, no glob

    mcpServers[spec.name] = server;
    allowedTools.push(`mcp__${spec.name}__*`);
  }

  return { mcpServers, allowedTools, managedEnvKeys: [...envKeys] };
}

// ---------------------------------------------------------------------------
// The canonical MatClaw catalog
// ---------------------------------------------------------------------------

export interface IntegrationCtx {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export function matclawIntegrations(ctx: IntegrationCtx): IntegrationSpec[] {
  return [
    cmd('matclaw', 'node', [ctx.mcpServerPath], {
      staticEnv: {
        MATCLAW_CHAT_JID: ctx.chatJid,
        MATCLAW_GROUP_FOLDER: ctx.groupFolder,
        MATCLAW_IS_MAIN: ctx.isMain ? '1' : '0',
      },
    }),
    cmd('gmail', 'npx', ['-y', '@gongrzhe/server-gmail-autoauth-mcp']),
    // Phase 1 drop-ins
    docker(
      'mp',
      'benedict2002/materials-project-mcp@sha256:b77c75cd6acb34905c940fdd0a732f0cb62d8957d0f9f964d708dad6f5fd49fd',
      { secretEnvKeys: ['MP_API_KEY'] },
    ),
    http('graphiti', 'GRAPHITI_ENDPOINT', 'GRAPHITI_API_KEY'),
    cmd('arxiv', 'uvx', ['arxiv-mcp-server@0.5.0']),
    // Phase 2 thin wrappers
    cmd('pymatgen_inputset', 'python', ['-m', 'matclaw_wrappers.pymatgen_inputset_mcp']),
    cmd('pymatgen_validation', 'python', ['-m', 'matclaw_wrappers.pymatgen_validation_mcp']),
    cmd('atomate2', 'python', ['-m', 'matclaw_wrappers.atomate2_maker_mcp'], {
      staticEnv: { JOBFLOW_CONFIG_FILE: '/workspace/group/.jobflow/jobflow.yaml' },
    }),
    cmd('jobflow_remote', 'python', ['-m', 'matclaw_wrappers.jobflow_remote_mcp'], {
      staticEnv: { JF_REMOTE_PROJECT: 'matclaw' },
    }),
    cmd('mlip', 'python', ['-m', 'matclaw_wrappers.mlip_unified_mcp'], {
      staticEnv: { MLIP_MODEL_CACHE: '/cluster/shared/mlip-models' },
    }),
    cmd('phonon_gw', 'python', ['-m', 'matclaw_wrappers.phonopy_yambopy_mcp']),
  ];
}

/**
 * The agent's full managed-env manifest: the base (non-integration) env keys
 * plus every integration's declared env keys. This is what the SDK env manager
 * (index.ts) passes/refreshes, derived from the same registry as the catalog
 * so the two cannot drift. (envKeys are ctx-independent, so a stub ctx is fine.)
 */
export function agentManagedEnvKeys(): string[] {
  const keys = new Set<string>(BASE_ENV_KEYS);
  const specs = matclawIntegrations({
    mcpServerPath: '',
    chatJid: '',
    groupFolder: '',
    isMain: false,
  });
  for (const spec of specs) {
    for (const k of spec.envKeys ?? []) keys.add(k);
  }
  return [...keys];
}
