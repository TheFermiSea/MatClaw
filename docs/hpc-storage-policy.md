# HPC Storage Policy

MatClaw must separate persistent project state from heavy solver scratch.
This prevents DFT and many-body workflows from filling shared storage and
crashing the controller database.

## Storage Roles

| Role | Use for | Do not use for |
|------|---------|----------------|
| Persistent NFS/shared project storage | Source inputs, scripts, notebooks, small logs, final summaries, selected final artifacts | QE `.wfc*`, YAMBO `SAVE/`, VASP `WAVECAR`/`CHGCAR`, large trajectories, bulk restart databases |
| Node-local or cluster scratch | Solver working directories, wavefunctions, charge density, temporary databases, restart files while a job is running | Permanent-only records without copy-back |
| MatClaw controller storage | Chat state, scheduler state, credentials, small workspace notes | Any solver output or generated high-volume scientific data |

On the Beefcake cluster, treat `/home/brian` and `/cluster/shared` as
persistent shared storage. They are useful for inputs and final results, but
they are not the right target for high-write DFT scratch. Heavy jobs submitted
to the `vasp-0x` nodes should stage into a scratch directory on the allocated
node when possible.

## Required Pattern

Every SLURM job that runs VASP, Quantum ESPRESSO, YAMBO, Wannier90, LAMMPS,
RASPA, or another write-heavy engine must follow this pattern:

1. Keep canonical inputs and user-visible outputs in an NFS project directory.
2. Create a per-job scratch directory under `$SLURM_TMPDIR`, `$TMPDIR`, or
   `/scratch/$USER`.
3. Copy only required inputs into scratch.
4. Run the solver from scratch.
5. Copy logs, final structures, parsed data, plots, and requested restart files
   back to NFS.
6. Remove scratch on successful copy-back unless the user asked to preserve it.

If no scratch directory exists or there is not enough free space, stop before
submitting the heavy calculation and report the problem.

## SLURM Template

Use this template for generated cluster jobs. Adjust modules, executables, and
file lists for the workflow.

```bash
#!/bin/bash
#SBATCH --job-name=matclaw-job
#SBATCH --nodes=1
#SBATCH --ntasks=32
#SBATCH --time=24:00:00
#SBATCH --output=slurm-%j.out

set -euo pipefail

PROJECT_NFS="${PROJECT_NFS:-$HOME/projects/my-project}"
RUN_NAME="${RUN_NAME:-run-${SLURM_JOB_ID:-manual}}"
PERSIST_DIR="$PROJECT_NFS/runs/$RUN_NAME"

SCRATCH_BASE="${SLURM_TMPDIR:-${TMPDIR:-/scratch/$USER}}"
WORKDIR="$SCRATCH_BASE/matclaw/$RUN_NAME"

mkdir -p "$PERSIST_DIR" "$WORKDIR"

free_kb=$(df -Pk "$SCRATCH_BASE" | awk 'NR==2 {print $4}')
min_kb=$((50 * 1024 * 1024))
if [ "$free_kb" -lt "$min_kb" ]; then
  echo "ERROR: scratch has less than 50 GiB free: $SCRATCH_BASE" >&2
  exit 2
fi

rsync -a "$PERSIST_DIR/input/" "$WORKDIR/"

copy_back() {
  mkdir -p "$PERSIST_DIR/results"
  rsync -a \
    --include='*/' \
    --include='*.out' \
    --include='*.err' \
    --include='*.xml' \
    --include='*.json' \
    --include='*.csv' \
    --include='*.png' \
    --include='CONTCAR' \
    --include='OSZICAR' \
    --include='OUTCAR' \
    --exclude='*' \
    "$WORKDIR/" "$PERSIST_DIR/results/"
}
trap copy_back EXIT

cd "$WORKDIR"

# Load cluster software here.
# module load vasp/6.4.3
# module load qe/7.5

# Run the solver here.
# srun vasp_std > vasp.out 2>&1
# srun pw.x -in scf.in > scf.out 2>&1
```

## Engine-Specific Rules

- VASP: run in scratch. Copy back `INCAR`, `POSCAR`, `KPOINTS`, `POTCAR`
  metadata, `OUTCAR`, `OSZICAR`, `CONTCAR`, `vasprun.xml`, and plots/tables.
  Copy `WAVECAR` or `CHGCAR` back only when the user explicitly needs a
  restart or follow-up calculation.
- Quantum ESPRESSO: set `outdir` to a scratch path, not the project directory.
  Copy back inputs, `.out` files, XML schema files, bands/DOS data, and plots.
  Do not leave `.wfc*` files in NFS project storage.
- YAMBO: create `SAVE/` and run databases in scratch. Copy back final reports,
  compact databases, and selected restart artifacts only when needed.
- Wannier90: keep `.win` and final `.hr.dat`/plots on NFS, but place large
  intermediate projections and copied wavefunctions in scratch.
- MD/MC workflows: write trajectories to scratch and downsample or compress
  before copy-back.

## Monitoring and Cleanup

MatClaw scheduled monitor tasks must check both job state and disk pressure:

```bash
squeue -j "$JOBID" || true
sacct -j "$JOBID" --format=JobID,State,ExitCode,Elapsed,MaxRSS || true
df -h "$PROJECT_NFS" "$SCRATCH_BASE" || true
du -sh "$WORKDIR" "$PERSIST_DIR" 2>/dev/null || true
```

Never delete scientific outputs without explicit user confirmation. If shared
storage exceeds 95% usage, pause new heavy job submissions and report the top
space consumers before taking action.
