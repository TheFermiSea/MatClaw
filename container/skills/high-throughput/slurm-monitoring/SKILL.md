---
name: slurm-monitoring
description: Keep MatClaw responsive while managing SLURM/HPC jobs. Use this for VASP, YAMBO, Wannier90, BerryPy, Quantum ESPRESSO, or other long-running cluster workflows that need status checks, completion monitoring, or follow-up actions without blocking the interactive chat.
---

# SLURM Monitoring Without Blocking Chat

## Rule

Never wait for a long HPC job by running a long foreground sleep in the interactive MatClaw turn.

Do not run:

```bash
sleep 7200 && squeue -j 1234
ssh login "sleep 7200 && sacct -j 1234"
while squeue -j 1234; do sleep 300; done
```

Those patterns block user steering. New user prompts may queue up but will not be acknowledged until the tool call returns.

## Correct Pattern

1. Submit or identify the SLURM job.
2. Send the user a concise acknowledgement with the job ID and expected next check.
3. Run only short foreground checks when needed.
4. Use `mcp__matclaw__schedule_task` for delayed or repeated checks.
5. Return control to the chat.

## Short Status Check

Use this when the user asks for current status:

```bash
ssh brian@10.0.0.5 "
  squeue -j JOBID -o '%.10i %.9P %.24j %.8u %.8T %.10M %.6D %R' 2>/dev/null || true
  sacct -j JOBID --format=JobID,State,ExitCode,Elapsed,MaxRSS 2>/dev/null || true
  tail -30 /path/to/job.out 2>/dev/null || true
"
```

This should complete quickly. If it hangs, stop and report the connectivity issue instead of adding sleeps.

## Scheduled One-Time Check

For a single future check, call the MatClaw scheduler tool instead of sleeping:

```
mcp__matclaw__schedule_task({
  prompt: "Check SLURM job JOBID. Report only if it completed, failed, disappeared from queue unexpectedly, produced the expected output file, or needs user attention. Include sacct state, elapsed time, MaxRSS, and the last relevant output lines.",
  schedule_type: "once",
  schedule_value: "YYYY-MM-DDTHH:MM:SS",
  context_mode: "group"
})
```

Use local time without a `Z` suffix for `schedule_value`.

## Recurring Poll

For long jobs, schedule a recurring check at a reasonable interval:

```
mcp__matclaw__schedule_task({
  prompt: "Poll SLURM job JOBID. If RUNNING/PENDING with no new issue, stay quiet. If COMPLETED, verify expected outputs and send a concise completion report. If FAILED/CANCELLED/TIMEOUT/OOM, send diagnostics and recommended next steps.",
  schedule_type: "interval",
  schedule_value: "900000",
  context_mode: "group"
})
```

`900000` ms is 15 minutes. Prefer 10-30 minute intervals for expensive DFT jobs.

## Completion Criteria

For VASP optical or response jobs, check both SLURM state and expected files:

```bash
sacct -j JOBID --format=JobID,State,ExitCode,Elapsed,MaxRSS
ls -lh WAVEDER WAVECAR vasprun.xml OUTCAR 2>/dev/null || true
tail -40 OUTCAR
tail -40 job-output.log
```

For YAMBO, check the run database/output files requested by the workflow, plus the scheduler state and final logs.

## User Safety

- Never cancel a job unless the user explicitly asks.
- Never delete WAVECAR, WAVEDER, SAVE databases, or large intermediate files unless the user explicitly confirms.
- If a monitor task discovers new scientific work, write a short memory note in `/workspace/group/` and tell the user what changed.
- Keep interactive replies short while jobs are running: job ID, state, elapsed time, and next scheduled check.
