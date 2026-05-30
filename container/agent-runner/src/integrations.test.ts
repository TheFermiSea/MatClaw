import { describe, it, expect } from 'vitest';
import {
  buildAgentConfig,
  matclawIntegrations,
  agentManagedEnvKeys,
  cmd,
  http,
  docker,
  BASE_ENV_KEYS,
  IntegrationConfigError,
  type EnvAccess,
  type IntegrationSpec,
} from './integrations.js';

/** Fake env seam: value() reads the fixture; endpoint() returns it verbatim. */
function fakeEnv(fixture: Record<string, string> = {}): EnvAccess {
  return {
    value: (k) => fixture[k] ?? '',
    endpoint: (k, fallback = '') => fixture[k] || fallback,
  };
}

const CTX = { mcpServerPath: '/srv.js', chatJid: 'web:chat', groupFolder: 'g', isMain: true };

describe('buildAgentConfig — lockstep derivation', () => {
  const specs: IntegrationSpec[] = [
    http('graphiti', 'GRAPHITI_ENDPOINT', 'GRAPHITI_API_KEY'),
    docker('mp', 'mp@sha256:abc', { secretEnvKeys: ['MP_API_KEY'] }),
    cmd('arxiv', 'uvx', ['arxiv-mcp-server@0.5.0']),
  ];

  it('registers http only when its endpoint env is set', () => {
    const off = buildAgentConfig(specs, fakeEnv({ MP_API_KEY: 'k' }));
    expect(off.mcpServers.graphiti).toBeUndefined();
    expect(off.allowedTools).not.toContain('mcp__graphiti__*');

    const on = buildAgentConfig(
      specs,
      fakeEnv({ GRAPHITI_ENDPOINT: 'http://g:8002/mcp/', GRAPHITI_API_KEY: 'sek', MP_API_KEY: 'k' }),
    );
    expect(on.mcpServers.graphiti).toEqual({
      type: 'http',
      url: 'http://g:8002/mcp/',
      headers: { 'X-API-Key': 'sek' },
    });
    expect(on.allowedTools).toContain('mcp__graphiti__*');
  });

  it('allowedTools mirrors mcpServers exactly (no orphan globs)', () => {
    const cfg = buildAgentConfig(specs, fakeEnv({ GRAPHITI_ENDPOINT: 'http://g/mcp/' }));
    const serverGlobs = Object.keys(cfg.mcpServers).map((n) => `mcp__${n}__*`).sort();
    expect([...cfg.allowedTools].sort()).toEqual(serverGlobs);
  });

  it('managedEnvKeys is base ∪ every spec key, even for gated-out servers', () => {
    // graphiti gated OFF (no endpoint) but its keys are still managed.
    const cfg = buildAgentConfig(specs, fakeEnv({}), { baseEnvKeys: ['BASE_A'] });
    expect(cfg.managedEnvKeys).toContain('BASE_A');
    expect(cfg.managedEnvKeys).toContain('MP_API_KEY');
    expect(cfg.managedEnvKeys).toContain('GRAPHITI_ENDPOINT');
    expect(cfg.managedEnvKeys).toContain('GRAPHITI_API_KEY');
    // de-duped
    expect(new Set(cfg.managedEnvKeys).size).toBe(cfg.managedEnvKeys.length);
  });

  it('assembles docker -e flags from secretEnvKeys at build time', () => {
    const cfg = buildAgentConfig(specs, fakeEnv({ MP_API_KEY: 'secret123' }));
    expect(cfg.mcpServers.mp).toEqual({
      command: 'docker',
      args: ['run', '--rm', '-i', '-e', 'MP_API_KEY=secret123', 'mp@sha256:abc'],
    });
  });

  it('command transport passes through command/args/staticEnv', () => {
    const cfg = buildAgentConfig(
      [cmd('atomate2', 'python', ['-m', 'x'], { staticEnv: { JF: '/c.yaml' } })],
      fakeEnv(),
    );
    expect(cfg.mcpServers.atomate2).toEqual({
      command: 'python',
      args: ['-m', 'x'],
      env: { JF: '/c.yaml' },
    });
  });

  it('select filters to a subset (the codex matclaw+gmail case)', () => {
    const cfg = buildAgentConfig(matclawIntegrations(CTX), fakeEnv(), {
      select: ['matclaw', 'gmail'],
    });
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['gmail', 'matclaw']);
    expect(cfg.allowedTools.sort()).toEqual(['mcp__gmail__*', 'mcp__matclaw__*']);
  });

  it('throws on duplicate integration names', () => {
    const dup = [cmd('a', 'x', []), cmd('a', 'y', [])];
    expect(() => buildAgentConfig(dup, fakeEnv())).toThrow(IntegrationConfigError);
  });
});

describe('matclawIntegrations catalog', () => {
  it('produces all 11 integrations in declaration order', () => {
    const names = matclawIntegrations(CTX).map((s) => s.name);
    expect(names).toEqual([
      'matclaw', 'gmail', 'mp', 'graphiti', 'arxiv',
      'pymatgen_inputset', 'pymatgen_validation', 'atomate2',
      'jobflow_remote', 'mlip', 'phonon_gw',
    ]);
  });

  it('threads ctx into the matclaw command env', () => {
    const matclaw = matclawIntegrations(CTX)[0];
    const cfg = buildAgentConfig([matclaw], fakeEnv());
    expect(cfg.mcpServers.matclaw).toMatchObject({
      command: 'node',
      args: ['/srv.js'],
      env: { MATCLAW_CHAT_JID: 'web:chat', MATCLAW_GROUP_FOLDER: 'g', MATCLAW_IS_MAIN: '1' },
    });
  });
});

describe('agentManagedEnvKeys (the env manifest)', () => {
  it('includes base keys, the ASTA keys, and integration keys', () => {
    const keys = agentManagedEnvKeys();
    // ASTA drift fix — all four present
    for (const k of ['ASTA_TOKEN', 'ASTA_API_KEY', 'ASTA_A2A_API_KEY', 'ASTA_GATEWAY_URL']) {
      expect(keys).toContain(k);
    }
    // integration-derived
    expect(keys).toContain('MP_API_KEY');
    expect(keys).toContain('GRAPHITI_ENDPOINT');
    expect(keys).toContain('GRAPHITI_API_KEY');
    // base superset
    for (const k of BASE_ENV_KEYS) expect(keys).toContain(k);
    // de-duped
    expect(new Set(keys).size).toBe(keys.length);
  });
});
