/**
 * Single source of truth for the env keys the controller passes to the agent.
 *
 *   - readSecrets()  (container-runner.ts) — initial spawn, via the stdin
 *     ContainerInput.secrets — passes SHARED_SECRET_KEYS.
 *   - writeSecrets() (group-queue.ts) — follow-up messages to an idle
 *     container, via the IPC _secrets.json — passes SHARED_SECRET_KEYS plus
 *     REFRESH_EXTRA_KEYS.
 *
 * Why the split: AGENT_ENGINE / AGENT_MODEL are delivered as `docker -e` flags
 * at spawn (see container-runner buildContainerArgs), so readSecrets omits them;
 * but there is no docker env on an IPC refresh, so writeSecrets must include
 * them. Everything else is identical — collapsing the two formerly-divergent
 * lists here fixed the drift where the ASTA keys were in readSecrets but
 * missing from writeSecrets (so ASTA creds weren't refreshed on follow-ups).
 *
 * This mirrors the agent-runner's BASE_ENV_KEYS + integration registry, which
 * lives in a separate package (no shared module across the controller /
 * agent-runner package boundary — see CONTEXT.md). The shared core should stay
 * aligned by review; the keys here are the controller's authoritative set.
 */

export const SHARED_SECRET_KEYS = [
  // Anthropic (Claude Code) auth
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  // ASTA (used via the mounted asta-cli)
  'ASTA_TOKEN',
  'ASTA_API_KEY',
  'ASTA_A2A_API_KEY',
  'ASTA_GATEWAY_URL',
  // Codex / OpenAI auth
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_MODEL',
  // Misc cloud
  'GOOGLE_API_KEY',
  // Integration secrets
  'MP_API_KEY',
  'GRAPHITI_ENDPOINT',
  'GRAPHITI_API_KEY',
  // TensorZero feedback (onCalcReport)
  'TENSORZERO_GATEWAY_URL',
] as const;

/**
 * Config delivered via `docker -e` at initial spawn but needs to ride the IPC
 * refresh channel for follow-up messages.
 */
export const REFRESH_EXTRA_KEYS = ['AGENT_ENGINE', 'AGENT_MODEL'] as const;

/** The full set written to the IPC _secrets.json on a follow-up message. */
export const REFRESH_SECRET_KEYS = [
  ...SHARED_SECRET_KEYS,
  ...REFRESH_EXTRA_KEYS,
] as const;
