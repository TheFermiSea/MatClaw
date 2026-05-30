# MatClaw — Architecture Context

Domain + architecture terms used in code and in `/improve-codebase-architecture`
reviews. Add terms as deepening decisions crystallize.

## Integration
An external capability the agent exposes as an MCP server — graphiti (memory),
mp (Materials Project), arxiv, gmail, the pymatgen/atomate2/jobflow wrappers,
etc. Each integration is declared **once** as an `IntegrationSpec`.

## IntegrationSpec
The single declarative row describing one integration: its `name`, its
`transport`, and the env/secret keys it needs. The source of truth from which
the agent's MCP catalog, the `allowedTools` globs (`mcp__<name>__*`), and the
managed-env manifest are **derived** — they can no longer drift out of lockstep.

## Transport
How an integration's MCP server is launched or reached. A **closed tagged
union**: `http` (url + headers, registered only when its endpoint env is set),
`docker` (a `docker run` of a digest-pinned image), `command` (a stdio process
— node / npx / uvx / python).

## Integration registry
The list of `IntegrationSpec`s plus the pure builder (`buildAgentConfig`) that
derives the three lockstep artifacts in one pass. Replaces the formerly-
scattered `mcpServers` literal + `allowedTools` array (claude.ts) and
`MANAGED_SDK_ENV_KEYS` (index.ts). Lives in the agent-runner package. The
controller keeps a sibling **secret manifest** (the collapse of
`readSecrets` + `writeSecrets`), because the controller and agent-runner are
separate packages with no shared module.

## Secret / env manifest
The set of env keys the controller passes to the agent (and the agent's SDK
refreshes). Derived from each `IntegrationSpec`'s declared keys. The drift this
removes: ASTA keys present in `readSecrets` but missing from `writeSecrets` and
the agent's managed list.
