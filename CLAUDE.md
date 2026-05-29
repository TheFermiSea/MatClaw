# MatClaw

## Git Branch & Push Strategy

- **Local `matclaw-release`** → stable, pushes to `main` on all remotes
- **Local `dev`** → experimental, pushes to `dev` on github (DingyangLyu/MatClaw)
- New features and large changes go on `dev` first, merge to `matclaw-release` after testing
- Push commands:
  - Stable: `git push github matclaw-release:main` (+ gitee, zgca, bjzgcai)
  - Dev: `git push github dev`
- **NEVER add Co-Authored-By to commits**

## About

Materials science AI assistant powered by Claude Agent SDK, with integrated computational materials science tools (Quantum ESPRESSO, LAMMPS, RASPA3, MACE, pymatgen, ASE, etc.).

## MatClaw v2 (in progress on `beefcake/agent-steerability`)

This branch carries the v2 redesign — keeping the chat shell, consuming
materials-science tooling via MCP. See `docs/v2-roadmap.md` for the
canonical design.

Active MCP namespaces (visible to the agent via `allowedTools`):
- `mcp__matclaw__*` — chat + scheduling primitives (existing)
- `mcp__gmail__*` — email integration (existing)
- `mcp__vaspilot__*` — VASPilot DFT workflow MCP (Phase 1)
- `mcp__mp__*` — Materials Project (Phase 1; community MCP, MIT, digest-pinned)
- `mcp__graphiti__*` — bi-temporal entity-graph memory (Phase 1)
- `mcp__mem0__*` — per-session memory (Phase 1)
- `mcp__arxiv__*` — arXiv search + semantic indexing (Phase 1)
- `mcp__pymatgen_inputset__*` — VASP input-set generation (Phase 2)
- `mcp__pymatgen_validation__*` — VASP validator → ConvergenceVerdict (Phase 2)
- `mcp__atomate2__*` — atomate2 Flow makers (Phase 2)
- `mcp__jobflow_remote__*` — remote job submit + poll (Phase 2)
- `mcp__mlip__*` — unified MACE/CHGNet/MatterSim/MatterGen (Phase 2)
- `mcp__phonon_gw__*` — phonopy + yambopy (Phase 2)

Active matclaw v2 skills (under `container/skills/materials/`):
- `materials/research-plan` — pre-execution planner
- `materials/dry-run-validate` — pre-SLURM-submit gates
- `materials/parameter-recall` — Graphiti-backed param memory
- `materials/mlip-screen-vasp-final` — Pareto-tier screening
- `materials/imaginary-phonon-response` — graduated remedy strategy

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory. Containers include a full materials computation environment with DFT, MD, MC tools and Miniconda for flexible package management.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser/` | Browser automation tool (available to all agents via Bash) |
| `container/skills/materials-compute/` | Materials computation guide (QE, LAMMPS, RASPA3, MACE, pymatgen, ASE) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-matclaw` | Bring upstream MatClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.matclaw.plist
launchctl unload ~/Library/LaunchAgents/com.matclaw.plist
launchctl kickstart -k gui/$(id -u)/com.matclaw  # restart

# Linux (systemd)
systemctl --user start matclaw
systemctl --user stop matclaw
systemctl --user restart matclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Agent does not acknowledge new prompts:** Check for an active container blocked in a long Bash tool call. Interactive MatClaw turns must stay steerable; do not monitor HPC jobs with `sleep 300`, `sleep 7200`, or similar foreground commands. Use `mcp__matclaw__schedule_task` for periodic job checks, or run short direct status checks (`squeue`, `sacct`, `tail`) and then return control to the chat. New user messages are delivered through `/workspace/ipc/input`; stale `_close` sentinels should not remain when a follow-up message is queued.

**HPC monitoring policy:** Long-running calculations belong in SLURM. Long-running monitors belong in MatClaw scheduled tasks or external polling, not inside the interactive agent's Bash command. The interactive agent should acknowledge user steering promptly and should never block the foreground turn waiting hours for a job to finish.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
