# MatClaw v2 — MCP-Gateway Integration Roadmap

**Status:** Design locked 2026-05-27. Implementation in progress on `beefcake/agent-steerability`.
**This file:** the canonical design doc for matclaw v2. The vendored copy at `beefcake-swarm/docs/matclaw-v2-roadmap.md` mirrors this content for cross-repo discoverability; project-management state (the bd epic + leaf tasks) lives in beefcake-swarm.
**Branch policy:** `main` stays untouched (currently-running production). All v2 work lands on `beefcake/agent-steerability`. The earlier `beefcake/oauth-token-refresh-fix` branch carries the predecessor refactors (auth fixes, NotebookLM persistence, IPC steering, heartbeat telemetry, implicit-any cleanup) and is the parent of `agent-steerability`.
**Foundation choice:** Stay on the MatClaw chat shell. **Do not migrate.** Consume external materials-science tooling via MCP.

---

## 0. Why this plan exists (TL;DR)

Eleven independent research agents (two parallel passes) converged on the same conclusion: **MatClaw's contribution is the chat shell + skills + per-group container isolation; everything else should be consumed via MCP.** Total integration cost is ~870-960 LOC + 4-6 new daemons — roughly **5× cheaper** than my prior "rewrite + port" plan and dramatically more maintainable (upgrades are `pip install -U`, not patches).

The architectural principle, from the verification-research agent: **"The LLM narrates; deterministic validators decide."**

---

## 1. Architecture diagram

```
                   ┌────────────────────────────────────────────────────────────┐
                   │                  USER (chat channel: web / WhatsApp / TG)  │
                   └─────────────────────────────┬──────────────────────────────┘
                                                 │
                                                 ▼
       ┌─────────────────────────────────────────────────────────────────────────┐
       │                       MatClaw controller (TypeScript)                   │
       │   - GroupQueue (sendMessage, /interrupt prefix detection, IPC poller)   │
       │   - container-runner (per-group Docker, /workspace mount, .claude sync) │
       │   - schedule_task scheduler (current_tasks.json)                        │
       │   - channel adapters (Web, WhatsApp, Telegram, Feishu, …)               │
       │                          [host process, ~3000 LOC]                      │
       └────────────────────────────────┬────────────────────────────────────────┘
                                        │ docker run --rm matclaw-agent:beefcake-tools
                                        ▼
       ┌─────────────────────────────────────────────────────────────────────────┐
       │             Per-chat-group AGENT CONTAINER  (one per active group)      │
       │   - Claude Agent SDK (claude-sonnet-4-6, OAuth via mounted creds)       │
       │   - MessageStream + pollIpc loop (Steps 3-4 from 2026-05-26)            │
       │   - allowedTools: Bash, Read, Write, Skill, mcp__matclaw__*,            │
       │                   mcp__vaspilot__*, mcp__mp__*, mcp__graphiti__*,       │
       │                   mcp__mem0__*, mcp__pymatgen-vis__*, mcp__atomate2__*, │
       │                   mcp__jobflow__*, mcp__phonon__*, mcp__yambo__*,       │
       │                   mcp__mlip__*, mcp__arxiv__*                           │
       │   - 47 SKILL.md families synced from container/skills/                  │
       │   - Tool-call heartbeat + telemetry JSONL                               │
       │                          [~1500 LOC agent-runner]                       │
       └──────────┬──────────────────────────────────────────────────────────────┘
                  │
                  │  (all MCP traffic via stdio or HTTP-SSE)
                  ▼
       ┌─────────────────────────────────────────────────────────────────────────┐
       │           MCP MESH — drop-in servers + thin wrappers                    │
       │                                                                         │
       │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
       │  │ VASPilot MCP │ │ MP MCP       │ │ Graphiti MCP │ │ Mem0 MCP     │    │  Phase 1
       │  │ (drop-in,    │ │ (community,  │ │ + Neo4j      │ │ + Postgres   │    │  drop-ins
       │  │  arXiv 2508. │ │  21 tools)   │ │ (bi-temporal │ │ (per-session │    │  (0 LOC)
       │  │  07035)      │ │              │ │  KG memory)  │ │  memory)     │    │
       │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘    │
       │                                                                         │
       │  ┌──────────────┐ ┌──────────────────┐ ┌────────────────┐               │
       │  │ arXiv MCP    │ │ IOWarp SLURM MCP │ │ ASE+pymatgen   │               │
       │  │ (blazickjp)  │ │ (research-grade) │ │ MCP (drop-in)  │               │
       │  └──────────────┘ └──────────────────┘ └────────────────┘               │
       │                                                                         │
       │  ──────────  thin wrappers MatClaw owns (~830 LOC)  ──────────          │
       │                                                                         │
       │  ┌─────────────────────────────────────┐                                │
       │  │ pymatgen-vasp-inputset-mcp  ~150 L  │  MPRelaxSet, MatPESStaticSet   │  Phase 2
       │  │ pymatgen-io-validation-mcp  ~100 L  │  VaspValidator → ConvVerdict   │  wrappers
       │  │ atomate2-maker-mcp          ~200 L  │  Flows: relax, bands, GW, BSE  │
       │  │ jobflow-remote-mcp          ~150 L  │  submit/poll over SLURM        │
       │  │ mlip-unified-mcp            ~250 L  │  MACE/CHGNet/MatterSim/Gen     │
       │  │ phonopy-yambopy-mcp         ~350 L  │  imaginary-ω detect, GW gen    │
       │  └─────────────────────────────────────┘                                │
       └──────────────────────────────────────┬──────────────────────────────────┘
                                              │
                                              │  pure Python imports, pip-installed
                                              ▼
       ┌─────────────────────────────────────────────────────────────────────────┐
       │                        UNDERLYING LIBRARIES                             │
       │   pymatgen · atomate2 · jobflow · jobflow-remote · pymatgen-io-         │
       │   validation · phonopy · yambopy · ase · mace-torch · chgnet ·          │
       │   mattersim · mattergen · mp_api · dspy · gepa                          │
       └─────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
       ┌─────────────────────────────────────────────────────────────────────────┐
       │                       EXECUTION SUBSTRATE                               │
       │   SLURM (vasp-01/02/03), local Python in container, ai-proxy LXC        │
       └─────────────────────────────────────────────────────────────────────────┘

       Cross-cutting (no changes — already in place):
       - TensorZero gateway (ai-proxy, Postgres) — feedback metric per material class (Phase 4)
       - NotebookLM + Asta — semantic external KB (unchanged)
       - per-group .claude/projects/*.jsonl — SDK session resume
       - PreCompact hook → /workspace/group/conversations/*.md
       - /workspace/group/.matclaw/tool-timings.jsonl (Step 4 telemetry)
```

---

## 2. Phase 0 deliverable — Pydantic schemas

These are the structured-output contracts used by every MCP tool return + every Claude-narrated scientific claim. **Adopt the Anthropic Structured Outputs beta** (`structured-outputs-2025-11-13` header flag) on all Claude calls that consume a schema.

**Canonical home** (this repo): `container/agent-runner/src/schemas/matclaw_v2.py`. The TypeScript mirror at `container/agent-runner/src/schemas/matclaw_v2.ts` is auto-generated via `scripts/check-schema-sync.sh` (drift detection runs in CI). Tests co-located at `container/agent-runner/src/schemas/test_matclaw_v2.py` (run with `python -m pytest`; matclaw has no pytest infrastructure yet — production CI runs the same tests against the vendored copy in beefcake-swarm).

**Vendored copies** in beefcake-swarm (kept in sync manually when this file changes):
  - `python/matclaw_schemas/matclaw_v2.py` — re-exported as a package so future Phase 2 MCP wrappers can `from matclaw_schemas import …` without depending on the matclaw container.
  - `python/tests/test_matclaw_schemas.py` — same 21 roundtrip tests, runs in beefcake-swarm's pytest suite.

Rationale for placement here: matclaw is the primary consumer of the schemas (every claude-agent-sdk call inside the container uses them); other consumers (Phase 2 wrappers, TensorZero feedback ingestion, Graphiti entity storage) vendor downstream. The original 2026-05-27 design placed the canonical home in beefcake-swarm; on 2026-05-28 it moved to matclaw to colocate with the structured-outputs beta wiring in `claude.ts` and keep main untouched.

### 2.1 `EvidencePointer`

Identifies an exact location in a file that backs a scientific claim.

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional

class EvidencePointer(BaseModel):
    """A pointer to a specific span of bytes in a file that justifies a claim.
    Every scientific assertion in a CalcReport must cite at least one of these."""
    file_path: str = Field(..., description="Absolute path inside the container or remote (ssh) host")
    remote_host: Optional[str] = Field(None, description="If file is on a remote host, the user@host string")
    line_start: int = Field(..., ge=1, description="1-indexed first line")
    line_end: int = Field(..., ge=1, description="1-indexed last line (inclusive)")
    sha256: Optional[str] = Field(None, description="SHA-256 of the file when read; allows post-hoc verification")
    snippet: str = Field(..., max_length=2000, description="The actual text, max 2KB")
```

### 2.2 `ConvergenceVerdict`

The deterministic verdict from a validator MCP tool. **Replaces the "verifier subagent" pattern** by being machine-produced.

```python
from typing import Literal

CodeName = Literal["vasp", "qe", "yambo", "berkeleygw", "lammps", "crystal", "phonon"]
VerdictLevel = Literal["pass", "warn", "fail", "inconclusive"]

class ConvergenceVerdict(BaseModel):
    code: CodeName
    verdict: VerdictLevel
    calc_id: str = Field(..., description="A stable identifier for the calculation (e.g. SLURM job ID + structure hash)")
    evidence: list[EvidencePointer] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list, description="Human-readable per-rule violations")
    rules_passed: list[str] = Field(default_factory=list, description="Rule IDs from pymatgen-io-validation etc.")
    rules_failed: list[str] = Field(default_factory=list)
    raw_validator_output: Optional[dict] = Field(None, description="Raw dict from underlying library (e.g. pymatgen VaspValidator)")
    timestamp_iso: str = Field(..., description="UTC ISO-8601 of when the verdict was computed")
```

### 2.3 `CalcReport`

The canonical structured-output that an agent returns after a calculation. **This is what gets stored in Graphiti as an entity, and what TensorZero reads to compute the `matclaw_calc_converged` feedback metric.**

```python
from datetime import datetime

class MaterialEntity(BaseModel):
    formula: str = Field(..., description="Pretty formula, e.g. 'NbOCl2'")
    structure_hash: str = Field(..., description="Stable hash of the canonicalized Structure (pymatgen StructureMatcher fingerprint)")
    space_group: Optional[str] = Field(None, description="International HM symbol, e.g. 'Pmn21' (#31)")
    space_group_number: Optional[int] = Field(None, ge=1, le=230)
    nsites: int = Field(..., ge=1)
    elements: list[str] = Field(..., description="Sorted list of element symbols")
    material_class: Optional[str] = Field(None, description="Human or skill-assigned class tag, e.g. '2d-ferroelectric'")
    mp_id: Optional[str] = Field(None, description="Materials Project mp-XXXX if known")
    notes: Optional[str] = None

class CalcReport(BaseModel):
    """Single source of truth for a completed calculation.
    Emitted by validator MCP tools; consumed by Graphiti, Mem0, TensorZero, and the chat UI."""
    calc_id: str = Field(..., description="Globally unique. Format: '<job_id>_<structure_hash>_<calc_type>'")
    material: MaterialEntity
    calc_type: Literal["relax", "static", "nscf", "bands", "dos", "phonon", "gw", "bse", "md", "wannier", "elastic", "optics"]
    code: CodeName
    code_version: Optional[str] = Field(None, description="e.g. 'VASP 6.4.3'")
    functional: Optional[str] = Field(None, description="e.g. 'PBE', 'PBEsol', 'HSE06', 'r2SCAN'")
    pseudopotentials: Optional[dict[str, str]] = Field(None, description="element -> POTCAR/UPF identifier")
    input_summary: dict = Field(default_factory=dict, description="Key INCAR/&control params: ENCUT, KSPACING, EDIFF, ISMEAR, etc.")
    status: Literal["queued", "running", "completed", "failed", "aborted"]
    verdict: Optional[ConvergenceVerdict] = None
    energy_ev: Optional[float] = Field(None, description="Final total energy in eV (per cell unless noted)")
    energy_per_atom_ev: Optional[float] = None
    band_gap_ev: Optional[float] = None
    direct_gap_ev: Optional[float] = None
    max_force_ev_per_ang: Optional[float] = None
    elapsed_seconds: Optional[float] = None
    wall_seconds: Optional[float] = None
    n_electronic_steps: Optional[int] = None
    n_ionic_steps: Optional[int] = None
    output_files: list[EvidencePointer] = Field(default_factory=list, description="Pointers to OUTCAR, vasprun.xml, .out, etc.")
    submitted_at: datetime
    completed_at: Optional[datetime] = None
    slurm_job_id: Optional[str] = None
    slurm_partition: Optional[str] = None
    slurm_nodes: Optional[list[str]] = None
    chat_session_id: Optional[str] = None
    chat_group: Optional[str] = None
    derived_from: Optional[str] = Field(None, description="calc_id of a parent calc (e.g. NSCF derived from SCF)")
    tags: list[str] = Field(default_factory=list)
```

### 2.4 `MlipPrediction`

For the Pareto-tier "MLIP screen → VASP final" pattern.

```python
class MlipPrediction(BaseModel):
    material: MaterialEntity
    model: Literal["mace-mp-0", "chgnet", "mattersim", "mattergen", "other"]
    model_version: Optional[str] = None
    energy_ev: float
    forces_max_ev_per_ang: float
    forces_rms_ev_per_ang: float
    uncertainty_meta: Optional[dict] = Field(None, description="Model-specific uncertainty quantification")
    elapsed_seconds: float
    notes: Optional[str] = None
```

### 2.5 `SchedulerJobState`

For SLURM polling via `schedule_task`.

```python
class SchedulerJobState(BaseModel):
    job_id: str
    state: Literal["PENDING", "RUNNING", "COMPLETED", "CANCELLED", "FAILED", "TIMEOUT", "OUT_OF_MEMORY", "UNKNOWN"]
    elapsed: Optional[str] = Field(None, description="HH:MM:SS")
    estimated_remaining: Optional[str] = None
    nodes: list[str] = Field(default_factory=list)
    stdout_tail: Optional[str] = Field(None, max_length=4000)
    stderr_tail: Optional[str] = Field(None, max_length=4000)
    expected_outputs_present: dict[str, bool] = Field(default_factory=dict, description="filename -> exists")
```

---

## 3. Phase 1 deliverable — MatClaw config changes for drop-in MCP servers

### 3.1 Where MCP servers register

In `container/agent-runner/src/engines/claude.ts` around line 410 there's an `mcpServers: {…}` block currently containing `matclaw` and `gmail`. We extend this block. For each drop-in, the pattern is **stdio with command/args** for Python-based servers and **HTTP (SSE)** for already-deployed servers like VASPilot.

### 3.2 `claude.ts` mcpServers extension

```typescript
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

  // ---- Phase 1 drop-ins ----

  vaspilot: {
    // VASPilot ships its own MCP server (arXiv:2508.07035).
    // P1.1 update (2026-05-29): VASPilot's LLM backend (used internally
    // for its agentic planning steps) routes through CLIAPIProxy on
    // ai-proxy:8317 with SWARM_CLOUD_API_KEY — see vaspilot service's
    // OPENAI_BASE_URL / ANTHROPIC_BASE_URL env vars in
    // infrastructure/matclaw-v2/docker-compose.yml. No separate Anthropic
    // key needed. The VASPILOT_API_KEY below is for VASPilot's OWN HTTP
    // gateway auth (rate limiting), not an LLM credential.
    type: 'http',
    url: 'http://ai-proxy:8933/sse',
    headers: { 'X-API-Key': process.env.VASPILOT_API_KEY ?? '' },
  },
  mp: {
    // Materials Project — community wrapper (benedictdebrah).
    // P1.6 audit (2026-05-29): repo MIT-licensed, solo author (10 stars),
    // last pushed 2026-05-20. mp_api 0.46 confirmed to have NO built-in
    // MCP submodule. fair2wise/materials_project_mcp alternative is stale
    // (1 star, abandoned 2025-06). The community wrapper is not on PyPI
    // and has no Python entry-point — Docker is the upstream-recommended
    // invocation, with image digest pinned per the §5 risk-inventory
    // "audit any solo-author repo before adoption" requirement.
    command: 'docker',
    args: [
      'run', '--rm', '-i',
      '-e', `MP_API_KEY=${process.env.MP_API_KEY ?? ''}`,
      // Pinned to the audited image; bump after re-audit:
      'benedict2002/materials-project-mcp@sha256:b77c75cd6acb34905c940fdd0a732f0cb62d8957d0f9f964d708dad6f5fd49fd',
    ],
  },
  graphiti: {
    // bi-temporal entity graph; runs as docker compose stack on ai-proxy
    type: 'http',
    url: 'http://ai-proxy:8000/sse',
    headers: { 'X-API-Key': process.env.GRAPHITI_API_KEY ?? '' },
  },
  mem0: {
    // per-session agent memory; complementary to graphiti
    type: 'http',
    url: 'http://ai-proxy:7891/sse',
    headers: { 'X-API-Key': process.env.MEM0_API_KEY ?? '' },
  },
  arxiv: {
    // arxiv-mcp-server v0.5.0 (Apache-2.0, PyPI). P1.6 install (2026-05-29):
    // 10 tools verified — search_papers, download_paper, list_papers,
    // read_paper, get_abstract, semantic_search, reindex, citation_graph,
    // watch_topic, check_alerts.
    command: 'uvx',
    args: ['arxiv-mcp-server@0.5.0'],
  },

  // ---- Phase 2 thin wrappers (added incrementally) ----

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
```

### 3.3 `allowedTools` extension (`claude.ts` ~line 385)

```typescript
allowedTools: [
  // existing
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop', 'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
  'mcp__matclaw__*', 'mcp__gmail__*',

  // Phase 1 drop-ins
  'mcp__vaspilot__*', 'mcp__mp__*', 'mcp__graphiti__*', 'mcp__mem0__*', 'mcp__arxiv__*',

  // Phase 2 wrappers (uncomment as each lands)
  // 'mcp__pymatgen_inputset__*', 'mcp__pymatgen_validation__*',
  // 'mcp__atomate2__*', 'mcp__jobflow_remote__*',
  // 'mcp__mlip__*', 'mcp__phonon_gw__*',
],
```

### 3.4 Anthropic Structured Outputs beta header

In whatever code path constructs the `Anthropic` client (the SDK's HTTP requests), append the beta header:

```typescript
// Existing Anthropic-Beta header value (verified earlier):
// "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,
//  prompt-caching-scope-2026-01-05,effort-2025-11-24,adaptive-thinking-2026-01-28"

// Add:
// ",structured-outputs-2025-11-13"
```

This is typically a single-line change in the SDK's `defaultHeaders` or equivalent. The Claude Agent SDK respects `ANTHROPIC_BETA` env or its own constants; refer to current SDK docs.

### 3.5 docker-compose for backing daemons

Save as `infrastructure/matclaw-v2/docker-compose.yml` on ai-proxy:

```yaml
version: '3.8'
services:
  graphiti-neo4j:
    image: neo4j:5.26.6
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
      NEO4J_PLUGINS: '["apoc"]'
    volumes:
      - graphiti_neo4j_data:/data
    ports: ["7687:7687", "7474:7474"]
    restart: unless-stopped

  graphiti-mcp:
    image: zepai/graphiti-mcp:latest  # or self-built from getzep/graphiti mcp_server/
    environment:
      NEO4J_URI: bolt://graphiti-neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}  # for entity extraction
    depends_on: [graphiti-neo4j]
    ports: ["8000:8000"]  # SSE endpoint
    restart: unless-stopped

  mem0-postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: mem0
      POSTGRES_USER: mem0
      POSTGRES_PASSWORD: ${MEM0_DB_PASSWORD}
    volumes:
      - mem0_pg_data:/var/lib/postgresql/data
    restart: unless-stopped

  mem0-mcp:
    image: mem0ai/mem0-mcp:latest
    environment:
      POSTGRES_URL: postgres://mem0:${MEM0_DB_PASSWORD}@mem0-postgres:5432/mem0
      OPENAI_API_KEY: ${OPENAI_API_KEY}  # for embeddings (or swap for self-hosted)
    depends_on: [mem0-postgres]
    ports: ["7891:7891"]
    restart: unless-stopped

  vaspilot-mcp:
    image: jiaxuanliu/vaspilot-mcp:latest  # or build from VASPilot repo
    environment:
      VASP_BIN: /opt/vasp/bin/vasp_std
      SLURM_HOST: brian@10.0.0.5
      MP_API_KEY: ${MP_API_KEY}
    volumes:
      - /var/lib/matclaw/.ssh:/home/node/.ssh:ro
    ports: ["8933:8933"]
    restart: unless-stopped

volumes:
  graphiti_neo4j_data:
  mem0_pg_data:
```

### 3.6 `.env` additions for ai-proxy

```bash
NEO4J_PASSWORD=<generated>
MEM0_DB_PASSWORD=<generated>
GRAPHITI_API_KEY=<generated>
MEM0_API_KEY=<generated>
VASPILOT_API_KEY=<generated>
MP_API_KEY=<your existing Materials Project API key>
# OPENAI_API_KEY only needed if Mem0 uses OpenAI embeddings; otherwise route through CLIAPIProxy
```

### 3.7 Per-group secrets file extension

In `data/ipc/<group>/_secrets.json` (the file we patched for CLIAPIProxy bypass), add:

```json
{
  "MP_API_KEY": "...",
  "GRAPHITI_ENDPOINT": "http://ai-proxy:8000",
  "GRAPHITI_API_KEY": "...",
  "MEM0_ENDPOINT": "http://ai-proxy:7891",
  "MEM0_API_KEY": "...",
  "VASPILOT_ENDPOINT": "http://ai-proxy:8933"
}
```

The agent runner already refreshes these via `refreshSdkEnv` every poll cycle.

---

## 4. Per-phase implementation guide

### Phase 0 — Foundation (1 day)
Acceptance: Pydantic schemas in `container/agent-runner/src/schemas/`; Anthropic Structured Outputs beta flag flipped on; every MCP tool that returns structured data validates against its schema.

### Phase 1 — Drop-in MCP servers (1-2 days)
1. Apply §3.5 docker-compose on ai-proxy; verify each service `docker logs` is clean.
2. Apply §3.2 `claude.ts` mcpServers extension; rebuild dist (`npm run build`); restart matclaw.
3. Apply §3.3 allowedTools extension.
4. Smoke-test from a fresh container: ask the agent to "list available MCP tools" and confirm all expected `mcp__*__*` namespaces appear.
5. Smoke per server: `query MP for mp-1234`, `recall similar materials from graphiti`, `store this conversation snippet in mem0`, `search arxiv for NbOCl2`.

### Phase 2 — Six thin wrappers (~1-2 weeks)
Each wrapper lives under `python/matclaw_wrappers/<name>_mcp.py` in a new sibling repo or directly inside the agent container build. Uses **FastMCP** (already in MatClaw's container Python deps via `fastmcp==2.10.5`).

Skeleton for each wrapper (~50-100 LOC + per-tool logic):

```python
# python/matclaw_wrappers/pymatgen_validation_mcp.py
from fastmcp import FastMCP
from pymatgen.io.validation import VaspValidator
from pathlib import Path
from schemas.matclaw_v2 import ConvergenceVerdict, EvidencePointer
import hashlib, datetime

mcp = FastMCP("pymatgen-validation")

@mcp.tool()
async def validate_vasp_directory(directory: str, calc_id: str) -> dict:
    """Run pymatgen-io-validation against a VASP output directory.
    Returns a ConvergenceVerdict (serialized as dict)."""
    v = VaspValidator.from_directory(directory)
    evidence = []
    for fname in ("OUTCAR", "vasprun.xml", "INCAR"):
        p = Path(directory) / fname
        if p.exists():
            data = p.read_bytes()
            evidence.append(EvidencePointer(
                file_path=str(p), line_start=1, line_end=min(20, data.count(b"\n")),
                sha256=hashlib.sha256(data).hexdigest(),
                snippet=data[:2000].decode("utf-8", errors="replace"),
            ))
    verdict = ConvergenceVerdict(
        code="vasp",
        verdict="pass" if v.valid else "fail",
        calc_id=calc_id,
        evidence=evidence,
        reasons=v.reasons if hasattr(v, "reasons") else [],
        rules_passed=getattr(v, "rules_passed", []),
        rules_failed=getattr(v, "rules_failed", []),
        raw_validator_output=v.model_dump() if hasattr(v, "model_dump") else None,
        timestamp_iso=datetime.datetime.utcnow().isoformat() + "Z",
    )
    return verdict.model_dump()

if __name__ == "__main__":
    mcp.run()
```

Per-wrapper detail lives in the corresponding beads task.

### Phase 3 — Skill authoring (ongoing)
For each new skill, create `container/skills/<family>/<name>/SKILL.md` with YAML frontmatter `name:` and `description:`. The Claude Agent SDK auto-discovers them; no code changes needed (we verified this end-to-end during the 2026-05-26 session).

New skills to author:
1. `materials/research-plan` — port DREAMS' `planNexeHighPlan.py` prompt content
2. `materials/dry-run-validate` — LARA-HPC-style pre-flight gates (NELECT/ENMAX/MAGMOM/ISMEAR sanity) before SLURM submit
3. `materials/parameter-recall` — uses Graphiti MCP to recall past convergence parameters
4. `materials/mlip-screen-vasp-final` — Pareto-tier (MLIP relax → VASP static)
5. `materials/imaginary-phonon-response` — phonopy detection + SSCHA escalation

Also refactor 5-10 existing skills to call new MCP tools instead of writing bash directly.

### Phase 4 — TensorZero feedback (1 week)
Wire `CalcReport` emission to TensorZero. In MatClaw's host-side post-verifier hook:

```typescript
// Pseudocode — actual file depends on where ContainerOutput is parsed
import { TensorZeroClient } from './tensorzero';

async function onCalcReport(report: CalcReport) {
  await tz.feedback({
    metric: 'matclaw_calc_converged',
    value: report.verdict?.verdict === 'pass' ? 1.0 : 0.0,
    inference_id: report.calc_id,  // ties to the inference that planned this calc
    tags: {
      material_class: report.material.material_class ?? 'unknown',
      calc_type: report.calc_type,
      code: report.code,
      functional: report.functional ?? 'unknown',
    },
  });
}
```

After ~50 reports accumulate per material class, activate `track_and_stop` variant selection.

### Phase 5 — Observability (1 week)
- Extend `tool-timings.jsonl` schema to include MCP tool latency
- Add a dashboard view: "memory queries per session", "verdict pass/fail rate by class"
- Update README + CLAUDE.md hierarchy with the new tool surface
- Run a smoke-test suite against the NbOCl2 group to confirm regressions

---

## 5. Risk inventory

| Risk | Mitigation |
|---|---|
| Community MCP servers have code smells (66% per arXiv:2506.13538) | Pin commit SHAs in docker-compose. Audit any solo-author repo before adoption. |
| MCP tool-poisoning attacks | Vendor-backed (Graphiti, Mem0) + official (MP) only; community servers run in their own sandboxed containers without secrets access. |
| Schema drift between Pydantic Python and TypeScript mirror | Codegen TS from Pydantic once with `pydantic-to-typescript`; commit both; CI checks they match. |
| Container disk pressure from Mem0/Graphiti data | Already protected: hourly `slurm-ctl-disk-pressure-clean.sh` cron from 2026-05-26. Add `/var/lib/docker/volumes/` to disk-watch list. |
| Per-group container can't reach docker-compose services on host | Pass `--network host` or `--add-host ai-proxy:host-gateway` to `docker run` in container-runner.ts. |
| Anthropic Structured Outputs beta gets revoked | All schema validation also runs server-side in our MCP wrappers; SDK beta is purely for assistant-text JSON conformance. Loss is minimal. |
| TensorZero feedback density too low (n<50 per class within reasonable time) | Wait. Run-rate of ~5 calcs/day per active group means ~2 weeks per class. Don't activate track_and_stop until n≥50. |

---

## 6. References — every claim cited

### Core integration tools
- VASPilot: arXiv:2508.07035, github.com/JiaxuanLiu-Arsko/VASPilot
- Graphiti: github.com/getzep/graphiti (Apache-2.0, 26.7k stars)
- Mem0: github.com/mem0ai/mem0 (Apache-2.0, 56.9k stars)
- Materials Project MCP: github.com/benedictdebrah/materials-project-mcp
- pymatgen-io-validation: github.com/materialsproject/pymatgen-io-validation
- atomate2: github.com/materialsproject/atomate2
- jobflow-remote: github.com/Matgenix/jobflow-remote
- arXiv MCP: github.com/blazickjp/arxiv-mcp-server
- IOWarp SLURM MCP: toolkit.iowarp.ai/docs/mcps/slurm
- Anthropic Skills: github.com/anthropics/skills
- Anthropic Structured Outputs: platform.claude.com/docs/en/build-with-claude/structured-outputs

### Papers
- DREAMS: arXiv:2507.14267 (cherry-pick prompts only; no license → unforkable)
- LARA-HPC: arXiv:2604.22571, gitlab.com/l_sim/lara-hpc (pattern source for dry-run validation)
- TritonDFT: arXiv:2603.03372 (eval benchmark only, not integration)
- MCP Servers for Science: arXiv:2508.18489
- MCP security empirical study: arXiv:2506.13538

### Foundation/architecture
- Cognition's "Don't Build Multi-Agents": cognition.ai/blog/dont-build-multi-agents
- Anthropic's multi-agent research system: anthropic.com/engineering/multi-agent-research-system
- Salesforce Asynchronous Tool Usage: arXiv:2410.21620
- LangGraph multi-agent guide: machinelearningplus.com/gen-ai/langgraph-multi-agent-systems-supervisor-swarm-network/

---

## 7. Beads epic structure

See sibling output `bd epic show beefcake-<id>` for the live tracking. Top-level epic + 5 phase epics + ~25 leaf tasks. Dependencies: Phase 0 blocks Phases 2/4/5; Phase 1 is independent; Phase 2 blocks Phase 3 partly; Phase 4 depends on Phase 0+1+2; Phase 5 depends on everything.
