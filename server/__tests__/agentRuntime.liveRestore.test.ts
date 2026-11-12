import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider, LiveSession } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PersistedAgent } from '../src/types.js';

function createMockAdapter(initial: PersistedAgent[]): StateAdapter & {
  current: () => PersistedAgent[];
} {
  let current = initial;
  return {
    current: () => current,
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

/**
 * Restoring from the persisted roster must not bring back sessions that ended while
 * the server was off, but only when the CLI's own registry says so: with no registry
 * the roster is trusted as before, and agents that are not top-level sessions are
 * never judged by it.
 */
describe('AgentRuntime.restoreExternalAgents with a live-session registry', () => {
  let tmpDir: string;
  let runtime: AgentRuntime | undefined;
  const file = (n: string) => path.join(tmpDir, `${n}.jsonl`);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-restore-'));
    for (const n of ['live', 'dead', 'lead', 'mate']) fs.writeFileSync(file(n), '');
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const persisted = (id: number, name: string, extra: Partial<PersistedAgent> = {}) =>
    ({
      id,
      sessionId: name,
      terminalName: '',
      isExternal: true,
      jsonlFile: file(name),
      projectDir: tmpDir,
      ...extra,
    }) as PersistedAgent;

  function restore(
    roster: PersistedAgent[],
    live: LiveSession[] | null | undefined,
  ): { store: AgentStateStore; adapter: ReturnType<typeof createMockAdapter> } {
    const provider: HookProvider = { ...claudeProvider };
    if (live === undefined) delete provider.listLiveSessions;
    else provider.listLiveSessions = () => live;
    const adapter = createMockAdapter(roster);
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, provider);
    runtime.restoreExternalAgents();
    return { store, adapter };
  }

  it('drops a top-level session that is not running and keeps the one that is', () => {
    const { store } = restore(
      [persisted(1, 'live'), persisted(2, 'dead')],
      [{ sessionId: 'live', pid: 1, status: 'idle' }],
    );
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(false);
  });

  it('writes the pruned roster back, so the dropped session does not return next start', () => {
    const { adapter } = restore(
      [persisted(1, 'live'), persisted(2, 'dead')],
      [{ sessionId: 'live', pid: 1 }],
    );
    expect(adapter.current().map((a) => a.id)).toEqual([1]);
  });

  it('keeps everything when the registry is unavailable (null)', () => {
    const { store } = restore([persisted(1, 'live'), persisted(2, 'dead')], null);
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(true);
  });

  it('keeps everything when the provider has no registry at all', () => {
    const { store } = restore([persisted(1, 'live'), persisted(2, 'dead')], undefined);
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(true);
  });

  it('drops everything when the registry exists and nothing is running', () => {
    const { store } = restore([persisted(1, 'live'), persisted(2, 'dead')], []);
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(false);
  });

  it('matches by transcript name when the persisted session id is stale', () => {
    const { store } = restore(
      [persisted(1, 'live', { sessionId: 'an-older-id' })],
      [{ sessionId: 'live', pid: 1 }],
    );
    expect(store.has(1)).toBe(true);
  });

  it('never prunes team members: the registry has one entry per process, not per teammate', () => {
    const { store } = restore(
      [
        persisted(1, 'lead', { teamName: 'team-a', isTeamLead: true }),
        persisted(2, 'mate', { teamName: 'team-a', agentName: 'builder' }),
      ],
      [],
    );
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(true);
  });
});
