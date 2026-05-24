# Agent Instructions

This MatClaw deployment runs long scientific work through external schedulers such as SLURM. The interactive agent must remain steerable.

## Responsiveness Contract

- Do not block an interactive turn with long sleeps, long SSH sleeps, or polling loops.
- Do not run commands like `sleep 300`, `sleep 7200`, `ssh host "sleep ..."`, or `while ...; do sleep ...; done` to monitor cluster jobs.
- Submit cluster jobs, report the job ID, then return control to the user.
- Use `mcp__matclaw__schedule_task` for delayed or recurring checks.
- Use short foreground checks only: `squeue`, `sacct`, `tail`, `ls`, and focused validation commands.
- Keep VASP/YAMBO/Wannier90/BerryPy computation on the cluster, not inside the controller container.

## Operational Safety

- Never cancel SLURM jobs unless the user explicitly asks.
- Never delete large scientific outputs or restart from scratch without confirmation.
- Preserve user credentials and do not print tokens.
- When a new prompt arrives while work is running, acknowledge it promptly and adjust course.

## Relevant Skills

- Read `~/.claude/skills/materials-compute/SKILL.md` before materials calculations.
- Use `~/.claude/skills/high-throughput/slurm-monitoring/SKILL.md` for HPC job monitoring.
- Use local project memory in `/workspace/group/` for durable notes and lessons learned.
