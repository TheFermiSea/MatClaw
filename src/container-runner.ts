/**
 * Container Runner for MatClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_ENGINE,
  AGENT_MODEL,
  CONTAINER_GPU,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INTELLIGENCE_MODULE,
  TIMEZONE,
} from './config.js';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { agentEvents, parseStructuredEvent } from './web/events.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---MATCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MATCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export type AgentProfile = 'compute' | 'intelligence' | 'modeling' | null;

interface SkillProfiles {
  profiles: Record<string, { skills: string[]; exclude?: string[] }>;
}

/**
 * Resolve which skill directories an agent should receive.
 * If no profile is specified, all skills are loaded (with INTELLIGENCE_MODULE check).
 */
function resolveAllowedSkills(
  skillsSrc: string,
  profile: AgentProfile,
): Set<string> {
  const allDirs = fs
    .readdirSync(skillsSrc)
    .filter((e) => fs.statSync(path.join(skillsSrc, e)).isDirectory());

  // Load profiles.json if it exists
  const profilesPath = path.join(skillsSrc, 'profiles.json');
  if (profile && fs.existsSync(profilesPath)) {
    try {
      const config: SkillProfiles = JSON.parse(
        fs.readFileSync(profilesPath, 'utf-8'),
      );
      const prof = config.profiles[profile];
      if (prof) {
        const allowed = new Set(prof.skills);
        const excluded = new Set(prof.exclude || []);
        // Also include any skill not explicitly excluded (for future skills)
        for (const dir of allDirs) {
          if (!excluded.has(dir) && (allowed.has(dir) || allowed.has('*'))) {
            allowed.add(dir);
          }
        }
        logger.info(
          { profile, skills: [...allowed] },
          'Skill router: loaded profile',
        );
        return allowed;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load skill profiles, using defaults');
    }
  }

  // Default: all skills, with intelligence module check
  const intellEnabled =
    (globalThis as any).__INTELLIGENCE_MODULE_OVERRIDE ?? INTELLIGENCE_MODULE;
  const result = new Set(allDirs);
  if (!intellEnabled) result.delete('intelligence');
  return result;
}

/**
 * Generate mode-specific CLAUDE.md instructions based on agent profile.
 * Returns null for default (no override).
 */
function getModeInstructions(profile: AgentProfile): string | null {
  if (profile === 'intelligence') {
    return `# Operating Mode: Intelligence Only

You are a **research intelligence analyst**. Your job is to analyze research directions, collect data from academic sources, and provide expert evaluations.

## Your Capabilities
- Literature search (arXiv, Semantic Scholar, web search for Nature/Science/top journals)
- Materials database queries (Materials Project, AFLOW, OQMD)
- Patent landscape analysis
- Industry and market intelligence
- Multi-expert evaluation (7 independent AI expert reviews)
- Research trend visualization (publication trends, citation analysis)
- Research direction recommendations

## What You Do NOT Do
- You do NOT run DFT, MD, or any computational simulations
- You do NOT execute Quantum ESPRESSO, LAMMPS, MACE, or RASPA3
- You do NOT generate computation plans or parameters
- Your output is \`research_decision.json\` — a research direction recommendation

## Key Tools
\`\`\`bash
python3 /home/node/.claude/skills/intelligence/tools/arxiv_search.py "query" --max-results 30
python3 /home/node/.claude/skills/intelligence/tools/semantic_scholar.py "query" --limit 50
python3 /home/node/.claude/skills/intelligence/tools/materials_project_query.py --chemsys "Li-La-Zr-O"
python3 /home/node/.claude/skills/intelligence/tools/trend_analysis.py data.json --output figures/
python3 /home/node/.claude/skills/intelligence/tools/scoring.py expert_scores.json --output final_scores.json
\`\`\`

## Pipeline
Follow the 5-phase pipeline in \`/home/node/.claude/skills/intelligence/SKILL.md\`.
`;
  }

  if (profile === 'modeling') {
    return `# Operating Mode: Scientific Modeling (Designer, NOT Executor)

You are a **materials science research designer**. You design computational experiments — you do NOT execute them.

Think of yourself as the **principal investigator writing the research proposal**: you decide WHAT to calculate, WHICH method to use, and WHY, then hand the plan to your student (the Compute Agent) to execute.

## Your Role
- Analyze the physical problem: what phenomenon, what material system, what length/time scales
- Select physical models: Arrhenius diffusion, harmonic approximation, Boltzmann transport, NEB, etc.
- Map to computational methods: DFT-PBE/HSE06, MACE-MP-0, AIMD, phonopy, etc.
- Determine ALL parameters with physical justification
- Design convergence tests
- Define experimental validation strategy
- Use WebSearch to research method benchmarks and best practices from literature

## Strictly Forbidden
- **Do NOT run any computation commands** — no pw.x, lmp, python3 train.py, mpirun
- **Do NOT execute DFT/MD/MC calculations** — no Quantum ESPRESSO, LAMMPS, MACE execution
- **Do NOT write and run Python computation scripts** — no creating .py files and running them
- **You ONLY write computation_plan.json** — actual calculations are executed by the downstream Compute Agent

## Downstream Compute Agent Tools (reference these in your plan)
The Compute Agent has access to:
- Quantum ESPRESSO (pw.x, ph.x, pp.x) — DFT calculations
- LAMMPS — classical molecular dynamics
- MACE / MACE-MP-0 — machine learning interatomic potentials
- ASE — Atomic Simulation Environment
- pymatgen — structure analysis and manipulation
- phonopy — phonon calculations
- RASPA3 — Monte Carlo adsorption simulations
- BoltzTraP2 — electronic transport
- Miniconda Python environment with scientific packages

## Input
If \`/workspace/group/research_decision.json\` exists, read it for context.
Otherwise, work directly from the user's message.

## Output
Write \`/workspace/group/computation_plan.json\` with the complete computational design.
Follow the detailed workflow in \`/home/node/.claude/skills/modeling/SKILL.md\`.

## Key Principle
**Every parameter needs physical justification.** Not "60 Ry cutoff" but "60 Ry because Miara 2015 showed convergence within 1 meV/atom for LLZO at this value."
`;
  }

  if (profile === 'compute') {
    return `# Operating Mode: Computation

You are a **computational materials scientist**. You execute calculations, generate publication-quality figures, and present results clearly.

## Your Capabilities
- DFT calculations (Quantum ESPRESSO)
- Molecular dynamics (LAMMPS, MACE)
- Monte Carlo simulations (RASPA3)
- Machine learning potentials (MACE, other MLIPs)
- Crystal structure analysis (pymatgen, ASE)
- Data analysis and visualization (matplotlib)

## If computation_plan.json exists
Read it carefully. Execute the calculations exactly as specified — follow the parameters, convergence tests, and validation strategy.

## If research_decision.json exists (but no computation_plan.json)
Read it for context on what direction to pursue, then decide methods and parameters yourself.

## Mandatory Output Rules

### 1. Always include figures in your response
Every calculation that produces a plot MUST include it using markdown image syntax:
\`\`\`
![Band Structure](band_structure.png)
![Phonon Dispersion](si_phonon_combined.png)
\`\`\`
Do NOT just list file paths — embed the images so the user sees them directly.

### 2. Always write a structured summary
After calculations complete, present results as:
- **Method**: what was used (tool, parameters, system size)
- **Key Results**: with specific numbers and units
- **Validation**: comparison with experiment/literature if available
- **Figures**: embedded inline (not just file paths)
- **Output Files**: list generated files for the user

### 3. Generate publication-quality figures
- Always set \`figsize=(10, 6)\` or similar fixed size
- Use clear axis labels with units
- Add legends when multiple datasets
- Save as PNG with \`dpi=150\`
- **CRITICAL: Always set a fixed figure height. NEVER let height scale with data.**

### 4. Data Visualization
Always generate plots for numerical results. Never present raw numbers without a figure.
- Convergence tests → convergence plot
- Band structure → band plot
- DOS → DOS plot
- MD trajectory → property vs time plot
- Phonons → dispersion + DOS side-by-side
`;
  }

  return null;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  agentProfile: AgentProfile = null,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  // Uses agent profiles to determine which skills each agent role receives.
  // This ensures intelligence agents don't see computation skills and vice versa.
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    if (fs.existsSync(skillsDst)) {
      fs.rmSync(skillsDst, { recursive: true });
    }

    // Load agent profile to determine allowed skills
    const allowedSkills = resolveAllowedSkills(skillsSrc, agentProfile);

    for (const entry of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, entry);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      // Filter by profile
      if (!allowedSkills.has(entry)) continue;
      const dstDir = path.join(skillsDst, entry);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Write mode-specific CLAUDE.md directly to the group folder.
  // This is the CLAUDE.md the agent reads first (CWD = /workspace/group/).
  // The original group CLAUDE.md is backed up and restored when mode changes.
  // Write mode-specific CLAUDE.md to BOTH locations:
  // 1. groupSessionsDir → /home/node/.claude/CLAUDE.md (user-level, highest priority)
  // 2. groupDir → /workspace/group/CLAUDE.md (project-level)
  const modeInstructions = getModeInstructions(agentProfile);
  const sessionClaudeMd = path.join(groupSessionsDir, 'CLAUDE.md');
  const groupClaudeMd = path.join(groupDir, 'CLAUDE.md');
  const groupClaudeMdBackup = path.join(groupDir, '.CLAUDE.md.original');

  if (modeInstructions) {
    // Backup original group CLAUDE.md if not already backed up.
    // If no CLAUDE.md exists yet (new group), create empty backup so restore
    // doesn't accidentally keep profile instructions as the "original".
    if (!fs.existsSync(groupClaudeMdBackup)) {
      if (fs.existsSync(groupClaudeMd)) {
        fs.copyFileSync(groupClaudeMd, groupClaudeMdBackup);
      } else {
        fs.writeFileSync(groupClaudeMdBackup, '');
      }
    }
    // Write to both locations
    fs.writeFileSync(sessionClaudeMd, modeInstructions);
    fs.writeFileSync(groupClaudeMd, modeInstructions);
  } else {
    // No profile: restore original group CLAUDE.md, remove session override
    if (fs.existsSync(groupClaudeMdBackup)) {
      const backupContent = fs.readFileSync(groupClaudeMdBackup, 'utf-8');
      if (backupContent) {
        fs.copyFileSync(groupClaudeMdBackup, groupClaudeMd);
      } else {
        // Empty backup means group had no CLAUDE.md before profile mode
        try { fs.unlinkSync(groupClaudeMd); } catch { /* ok */ }
      }
      // Remove backup so it's re-created fresh next time a profile is used,
      // capturing any user edits made since the restore.
      try { fs.unlinkSync(groupClaudeMdBackup); } catch { /* ok */ }
    }
    try {
      fs.unlinkSync(sessionClaudeMd);
    } catch {
      /* doesn't exist */
    }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials directory (for Gmail MCP inside the container)
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false, // MCP may need to refresh OAuth tokens
    });
  }

  // Codex OAuth credentials (from `codex login` on host)
  // Mounted read-only so the Codex CLI can authenticate without an API key.
  // The CodexEngine writes config.toml separately for MCP server config.
  const codexAuthFile = path.join(homeDir, '.codex', 'auth.json');
  if (fs.existsSync(codexAuthFile)) {
    // Ensure the target directory exists in the container's codex home
    const groupCodexDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.codex',
    );
    fs.mkdirSync(groupCodexDir, { recursive: true });
    // Copy auth.json so it coexists with engine-generated config.toml
    fs.copyFileSync(codexAuthFile, path.join(groupCodexDir, 'auth.json'));
    mounts.push({
      hostPath: groupCodexDir,
      containerPath: '/home/node/.codex',
      readonly: false, // CodexEngine writes config.toml here at runtime
    });
  }

  // VASP remote configuration (for vasp-remote script in container)
  const vaspConfigDir = path.join(homeDir, '.vasp-remote');
  if (fs.existsSync(vaspConfigDir)) {
    mounts.push({
      hostPath: vaspConfigDir,
      containerPath: '/home/node/.vasp-remote',
      readonly: true,
    });
  }

  // SSH keys for VASP remote cluster access
  const sshDir = path.join(homeDir, '.ssh');
  if (fs.existsSync(vaspConfigDir) && fs.existsSync(sshDir)) {
    mounts.push({
      hostPath: sshDir,
      containerPath: '/home/node/.ssh',
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  const inputDir = path.join(groupIpcDir, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  // Clean stale input files from previous container runs to prevent
  // out-of-context or duplicate messages in the new container
  try {
    for (const f of fs.readdirSync(inputDir)) {
      try { fs.unlinkSync(path.join(inputDir, f)); } catch { /* ok */ }
    }
  } catch { /* ignore */ }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    if (fs.existsSync(groupAgentRunnerDir)) {
      fs.rmSync(groupAgentRunnerDir, { recursive: true });
    }
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Anthropic credentials are injected by the credential proxy — NOT passed here.
 * Only non-Anthropic API keys are passed via stdin.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    // Codex SDK (OpenAI-compatible)
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_MODEL',
    // Gemini
    'GOOGLE_API_KEY',
    // Materials science APIs
    'MP_API_KEY',
    'SEMANTIC_SCHOLAR_API_KEY',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass GPU access to container if configured
  if (CONTAINER_GPU) {
    args.push('--gpus', 'all');
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass agent engine and model selection to container.
  // Read fresh from .env each time so users can switch without restarting.
  const freshConfig = readEnvFile(['AGENT_ENGINE', 'AGENT_MODEL']);
  const engine = freshConfig.AGENT_ENGINE || AGENT_ENGINE;
  const model = freshConfig.AGENT_MODEL || AGENT_MODEL;
  args.push('-e', `AGENT_ENGINE=${engine}`);
  if (model) {
    args.push('-e', `AGENT_MODEL=${model}`);
  }

  // Pass operating mode so the agent knows its role
  const intellEnabled =
    (globalThis as any).__INTELLIGENCE_MODULE_OVERRIDE ?? INTELLIGENCE_MODULE;
  const freshMode = readEnvFile(['INTELLIGENCE_MODE']);
  const mode =
    freshMode.INTELLIGENCE_MODE ||
    (intellEnabled ? 'intelligence+compute' : 'compute');
  args.push('-e', `MATCLAW_MODE=${mode}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push('--add-host', 'host.docker.internal:host-gateway');
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://host.docker.internal:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode: SDK exchanges placeholder token for temp API key,
  //             proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  agentProfile: AgentProfile = null,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain, agentProfile);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `matclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Real-time streaming log: appended as stdout/stderr arrives
  // Use `tail -f` on this file to watch agent activity live
  const liveLogPath = path.join(logsDir, 'container-live.log');
  const liveStream = fs.createWriteStream(liveLogPath, { flags: 'w' });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Write live log header
    liveStream.write(`=== MatClaw Agent Live Log ===\n`);
    liveStream.write(`Started: ${new Date().toISOString()}\n`);
    liveStream.write(`Group: ${group.name}\n`);
    liveStream.write(`Container: ${containerName}\n`);
    liveStream.write(`${'='.repeat(60)}\n\n`);

    // Emit dashboard event: agent started
    agentEvents.emit('agent', {
      type: 'agent:start',
      group: group.name,
      groupFolder: group.folder,
      timestamp: new Date().toISOString(),
      data: { containerName, prompt: input.prompt },
    });

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Write to live log in real-time
      liveStream.write(chunk);

      // Emit dashboard event: stdout chunk
      agentEvents.emit('agent', {
        type: 'agent:stdout',
        group: group.name,
        groupFolder: group.folder,
        timestamp: new Date().toISOString(),
        data: { chunk },
      });

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Emit dashboard event: parsed agent output
            agentEvents.emit('agent', {
              type: 'agent:output',
              group: group.name,
              groupFolder: group.folder,
              timestamp: new Date().toISOString(),
              data: { result: parsed.result, status: parsed.status },
            });
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed)).catch((err) => {
              logger.error(
                { group: group.name, err },
                'onOutput handler failed',
              );
            });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();

      // Write stderr to live log with prefix
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) {
          liveStream.write(`[stderr] ${line}\n`);
          logger.debug({ container: group.folder }, line);

          // Parse structured events: [EVENT] {"type":"...","content":"..."}
          const structuredEvent = parseStructuredEvent(line);
          if (structuredEvent) {
            agentEvents.emit('agent', {
              type: 'agent:event',
              group: group.name,
              groupFolder: group.folder,
              timestamp: structuredEvent.timestamp || new Date().toISOString(),
              data: structuredEvent,
            });
          }
        }
      }

      // Emit dashboard event: stderr chunk
      agentEvents.emit('agent', {
        type: 'agent:stderr',
        group: group.name,
        groupFolder: group.folder,
        timestamp: new Date().toISOString(),
        data: { chunk },
      });
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Guard against double resolution (close + error can both fire)
    let resolved = false;

    container.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Sync Codex OAuth token back to host after container exits.
      // The Codex CLI may have refreshed the token during a long-running session;
      // writing it back ensures the host's auth.json stays fresh for next run.
      if (AGENT_ENGINE === 'codex') {
        const hostAuthFile = path.join(os.homedir(), '.codex', 'auth.json');
        const groupAuthFile = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          '.codex',
          'auth.json',
        );
        try {
          if (fs.existsSync(groupAuthFile)) {
            const hostStat = fs.existsSync(hostAuthFile)
              ? fs.statSync(hostAuthFile).mtimeMs
              : 0;
            const groupStat = fs.statSync(groupAuthFile).mtimeMs;
            if (groupStat > hostStat) {
              fs.mkdirSync(path.dirname(hostAuthFile), { recursive: true });
              fs.copyFileSync(groupAuthFile, hostAuthFile);
              logger.info('Synced refreshed Codex OAuth token back to host');
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to sync Codex auth.json back to host');
        }
      }

      // Close the live log stream
      liveStream.write(`\n${'='.repeat(60)}\n`);
      liveStream.write(`Finished: ${new Date().toISOString()}\n`);
      liveStream.write(
        `Duration: ${Math.round(duration / 1000)}s | Exit Code: ${code}\n`,
      );
      liveStream.end();

      // Emit dashboard event: agent finished
      agentEvents.emit('agent', {
        type: 'agent:end',
        group: group.name,
        groupFolder: group.folder,
        timestamp: new Date().toISOString(),
        data: { duration, exitCode: code },
      });

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          }).catch(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        // 137 = SIGKILL (docker kill), 143 = SIGTERM — expected when /stop or /new is used
        const isSignalKill = code === 137 || code === 143;
        if (isSignalKill && hadStreamingOutput) {
          logger.info(
            { group: group.name, code, duration },
            'Container killed after output was already captured — not an error',
          );
          // Fall through to success handling below
        } else {
          logger.error(
            {
              group: group.name,
              code,
              duration,
              stderr,
              stdout,
              logFile,
            },
            'Container exited with error',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          });
          return;
        }
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        }).catch(() => {
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.lastIndexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER, startIdx);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      liveStream.end();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  const tempTasksFile = `${tasksFile}.tmp`;
  fs.writeFileSync(tempTasksFile, JSON.stringify(filteredTasks, null, 2));
  fs.renameSync(tempTasksFile, tasksFile);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  const tempGroupsFile = `${groupsFile}.tmp`;
  fs.writeFileSync(
    tempGroupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tempGroupsFile, groupsFile);
}
