import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PersistedAgent } from '../src/types.js';

function createMockAdapter(initial: PersistedAgent[] = []): StateAdapter & {
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
 * Shutting the server down must not forget which sessions were open: the next start
 * restores them from the persisted roster (idle ones included), instead of only
 * re-adopting sessions that happen to have been written to in the last two minutes.
 */
describe('AgentRuntime -- dispose and the persisted roster', () => {
  let tmpDir: string;
  let runtime: AgentRuntime | undefined;
  const persistedAgent = (id: number, file: string): PersistedAgent => ({
    id,
    sessionId: `sess-${id}`,
    terminalName: '',
    isExternal: true,
    jsonlFile: file,
    projectDir: '/test',
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dispose-'));
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): { adapter: ReturnType<typeof createMockAdapter>; ids: number[] } {
    const files = [1, 2].map((n) => {
      const f = path.join(tmpDir, `s${n}.jsonl`);
      fs.writeFileSync(f, '');
      return f;
    });
    const adapter = createMockAdapter(files.map((f, i) => persistedAgent(i + 1, f)));
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.restoreExternalAgents();
    return { adapter, ids: [1, 2] };
  }

  it('plain dispose still empties the persisted roster (VS Code behaviour unchanged)', () => {
    const { adapter } = setup();
    expect(adapter.current()).toHaveLength(2);
    runtime?.dispose();
    runtime = undefined;
    expect(adapter.current()).toHaveLength(0);
  });

  it('dispose({ keepPersistedAgents }) leaves the roster on disk for the next start', () => {
    const { adapter } = setup();
    runtime?.dispose({ keepPersistedAgents: true });
    runtime = undefined;
    expect(adapter.current().map((a) => a.id)).toEqual([1, 2]);
  });
});
