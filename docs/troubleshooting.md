# Troubleshooting

Common issues and solutions for MatClaw installation, container builds, and runtime.

## Contents

- [Docker Build Issues](#docker-build-issues)
- [Container Runtime Issues](#container-runtime-issues)
- [Channel Connection Issues](#channel-connection-issues)
- [Agent Computation Issues](#agent-computation-issues)
- [HPC Storage Issues](#hpc-storage-issues)

---

## Docker Build Issues

### `pull access denied` / `failed to resolve source metadata for docker.io`

```
ERROR: failed to solve: ubuntu:24.04: failed to resolve source metadata for
docker.io/library/ubuntu:24.04: pull access denied
```

**Cause:** Docker Hub is inaccessible (network restrictions, especially in China).

**Solution A — Use a Docker Hub mirror:**

```bash
# For Docker Engine installed directly in Linux/WSL:
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.1panel.live"
  ]
}
EOF
sudo systemctl restart docker
```

For Docker Desktop: Settings → Docker Engine → add `"registry-mirrors"` to the JSON config, then restart.

**Solution B — Skip building, pull pre-built image instead:**

```bash
docker pull ghcr.io/dingyanglyu/matclaw-agent:latest
docker tag ghcr.io/dingyanglyu/matclaw-agent:latest matclaw-agent:latest
```

GHCR (GitHub Container Registry) is not affected by Docker Hub restrictions.

---

### Build fails with out-of-memory (OOM) / killed

```
c++: fatal error: Killed signal terminated program cc1plus
```

**Cause:** QE compiles with `make -j$(nproc)`, which uses all CPU cores. Each core needs ~2GB RAM.

**Solution:**

For WSL, increase memory limit in `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
memory=8GB
swap=4GB
```

Then restart WSL: `wsl --shutdown` from PowerShell.

Alternatively, limit parallelism by editing the Dockerfile `make -j$(nproc)` to `make -j2`.

---

### Build is extremely slow on WSL

**Cause:** Project files are on a Windows mount (`/mnt/c/...`). The 9P filesystem bridge is very slow for Docker COPY operations.

**Solution:** Clone the project into the WSL native filesystem:

```bash
cd ~
git clone https://github.com/DingyangLyu/MatClaw.git
cd MatClaw
./container/build.sh
```

---

### `no space left on device` during build

**Cause:** Docker build cache + QE compilation + Python packages need ~15GB. WSL's virtual disk or Docker's storage may be full.

**Solution:**

```bash
# Clean Docker build cache
docker builder prune -f
docker system prune -f

# Check Docker disk usage
docker system df
```

For WSL, the virtual disk (`.vhdx`) auto-expands but rarely auto-shrinks. If needed:

```powershell
# PowerShell (as admin)
wsl --shutdown
diskpart
# select vdisk file="C:\Users\<you>\AppData\Local\Docker\wsl\data\ext4.vhdx"
# compact vdisk
```

---

### `COPY failed: file not found` / stale build cache

**Cause:** Docker BuildKit caches COPY steps aggressively. `--no-cache` alone does NOT invalidate them.

**Solution:**

```bash
# Prune the builder completely, then rebuild
docker builder prune -af
./container/build.sh
```

---

### PyTorch / pip download timeout

**Cause:** PyTorch wheels are large (~800MB). Slow or unstable network causes timeout.

**Solution:** Use host networking for the build:

```bash
BUILD_NETWORK=host ./container/build.sh
```

Or set a pip mirror in the Dockerfile build args:

```bash
docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  -t matclaw-agent:latest container/
```

---

## Container Runtime Issues

### `EADDRINUSE: port 3210 already in use`

**Cause:** A previous MatClaw process or dashboard is still running.

**Solution:**

```bash
# Find and kill the process
lsof -ti:3210 | xargs kill -9

# Or change the port
DASHBOARD_PORT=3211 npm run dev
```

---

### Container exits immediately with no output

**Cause:** Missing or malformed JSON on stdin.

**Solution:** Ensure you pipe valid JSON:

```bash
echo '{"prompt":"Hello","groupFolder":"test","chatJid":"test@g.us","isMain":false,"secrets":{"ANTHROPIC_API_KEY":"sk-..."}}' \
  | docker run -i matclaw-agent:latest
```

---

### `CONTAINER_GPU=true` but no GPU available

```
docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]]
```

**Cause:** NVIDIA Container Toolkit not installed, or no GPU present.

**Solution:** Either install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), or disable GPU:

```bash
# In .env
CONTAINER_GPU=false
CONTAINER_IMAGE=matclaw-agent:latest
```

---

### Controller restart loop with SQLite disk I/O errors

```
SqliteError: disk I/O error
code: SQLITE_IOERR_FSYNC
```

**Cause:** The filesystem holding `store/messages.db` is full or unhealthy.
On HPC deployments this often happens when solver outputs are written into
shared home/NFS instead of scratch.

**Solution:**

```bash
df -h /home "$PWD" /cluster/shared 2>/dev/null || df -h
du -sh /home/* /cluster/shared/* 2>/dev/null | sort -h | tail
```

Free space without deleting scientific output first: prune Docker caches,
old logs, and old backups. Then pause stale scheduled tasks if they are
auto-spawning new worker containers, restart MatClaw, and move future solver
work to scratch. See `docs/hpc-storage-policy.md`.

---

### Deleted session causes `resume` error

```
Error: Session ID xxx not found in transcript
```

**Cause:** Transcript `.jsonl` file was deleted but session ID still exists in SQLite database.

**Solution:** Delete both:

```bash
# Delete transcript files
rm -rf data/sessions/<group>/.claude/projects/-workspace-group/<session-id>*.jsonl

# Delete database record
sqlite3 store/messages.db "DELETE FROM sessions WHERE session_id LIKE '<session-id>%';"
```

---

## Channel Connection Issues

### WhatsApp not connecting after upgrade

**Cause:** WhatsApp is a separate skill since v2026, not bundled in core.

**Solution:**

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp
npm run build
```

Existing auth credentials and groups are preserved.

---

### Feishu WebSocket disconnects repeatedly

**Cause:** Token expired or app permissions changed.

**Solution:**

```bash
# Re-authenticate
npm run auth:feishu

# Check .env has correct credentials
cat .env | grep FEISHU
```

---

## Agent Computation Issues

### QE calculation hangs or runs very slowly

**Cause:** Too many MPI processes for available cores, or ecutwfc too high.

**Solution:** The agent should auto-select reasonable parameters, but you can check:

```bash
# Inside container, check available cores
nproc

# Recommended: use at most nproc/2 for MPI to leave room for overhead
mpirun --allow-run-as-root -np 2 pw.x < input.in > output.out
```

---

### RASPA3 not available (arm64 / Apple Silicon)

**Cause:** RASPA3 only provides amd64 `.deb` packages. On arm64, RASPA3 is skipped during build.

**Solution:** Use an amd64 container with emulation:

```bash
docker run --platform linux/amd64 -i matclaw-agent:latest
```

Note: this is significantly slower due to QEMU emulation.

---

### `ModuleNotFoundError` for a Python package

**Cause:** Package not pre-installed in the container's conda environment.

**Solution:** The agent can install packages at runtime:

```bash
pip install <package-name>
# or
conda install -c conda-forge <package-name>
```

Pre-installed packages: numpy, scipy, matplotlib, pandas, seaborn, pymatgen, ase, mace-torch, mp-api, spglib, torch, chgnet, sevenn, matgl.

---

## HPC Storage Issues

### Shared home or NFS fills during VASP/QE/YAMBO jobs

**Cause:** Plane-wave and many-body codes wrote wavefunctions, charge density,
or restart databases into persistent shared storage. Examples include VASP
`WAVECAR`/`CHGCAR`, QE `.wfc*`, and YAMBO `SAVE/`.

**Solution:** Use persistent shared storage only for inputs and selected final
artifacts. Run the solver in node-local or cluster scratch and copy back small
results:

```bash
PROJECT_NFS="$HOME/projects/my-project"
SCRATCH_BASE="${SLURM_TMPDIR:-${TMPDIR:-/scratch/$USER}}"
WORKDIR="$SCRATCH_BASE/matclaw/${SLURM_JOB_ID:-manual}"
mkdir -p "$WORKDIR"
rsync -a "$PROJECT_NFS/input/" "$WORKDIR/"
cd "$WORKDIR"
```

After the run, copy back logs, final structures, parsed tables, plots, and
requested restart files. Do not copy large restart files back unless they are
needed for the next step.

### No scratch filesystem on the login/controller node

**Cause:** Scratch often exists only on compute nodes during SLURM allocation.

**Solution:** Do not test scratch assumptions only on the controller. Put the
scratch selection logic inside the SLURM script and check it after allocation:

```bash
SCRATCH_BASE="${SLURM_TMPDIR:-${TMPDIR:-/scratch/$USER}}"
df -h "$SCRATCH_BASE"
```

If the directory does not exist or has insufficient space, fail the SLURM job
before starting the solver and report the issue to the user.

---

## WSL-Specific Issues

### Docker commands fail with `permission denied`

**Solution:**

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER
# Log out and back in, or:
newgrp docker
```

---

### `wsl --shutdown` needed after config changes

Changes to `.wslconfig` (memory, swap, etc.) only take effect after restarting WSL:

```powershell
# From PowerShell
wsl --shutdown
# Then reopen your WSL terminal
```

---

## Still stuck?

Open an issue at [github.com/DingyangLyu/MatClaw/issues](https://github.com/DingyangLyu/MatClaw/issues) with:

1. Your OS and Docker version (`docker version`)
2. The full error output
3. Steps to reproduce
