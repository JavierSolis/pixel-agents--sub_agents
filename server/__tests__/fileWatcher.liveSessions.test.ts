import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts imports 'vscode' at load; see fileWatcherDismissal.test.ts.
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import type { HookProvider, LiveSession } from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_ACTIVE_THRESHOLD_MS } from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import { scanExternalDir, setDismissalTracker, setHookProvider } from '../src/fileWatcher.js';
import { PathSet } from '../src/pathKey.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * A running session is shown even when its transcript has been quiet for longer than
 * the activity window — its idleness is what the office displays. Without a registry
 * (or for a session that is not running) the window rules apply unchanged.
 */
describe('scanExternalDir with a live-session registry', () => {
  let tmpDir: string;
  let tracker: DismissalTracker;
  let knownJsonlFiles: PathSet;
  let agents: AgentStateStore;
  const timers = {
    fileWatchers: new Map<number, fs.FSWatcher>(),
    polling: new Map<number, ReturnType<typeof setInterval>>(),
    waiting: new Map<number, ReturnType<typeof setTimeout>>(),
    permission: new Map<number, ReturnType<typeof setTimeout>>(),
  };

  function provider(live: LiveSession[] | null | undefined): HookProvider {
    const base: HookProvider = { ...claudeProvider };
    if (live === undefined) {
      delete base.listLiveSessions;
    } else {
      base.listLiveSessions = () => live;
    }
    return base;
  }

  /** A transcript last written long enough ago to fall outside the activity window. */
  function staleTranscript(sessionId: string): string {
    const file = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '{"type":"assistant"}\n');
    const old = new Date(Date.now() - EXTERNAL_ACTIVE_THRESHOLD_MS - 60_000);
    fs.utimesSync(file, old, old);
    return file;
  }

  function scan(): void {
    scanExternalDir(
      tmpDir,
      knownJsonlFiles,
      { current: 1 },
      agents,
      timers.fileWatchers,
      timers.polling,
      timers.waiting,
      timers.permission,
      () => {},
      { current: false },
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-live-'));
    tracker = new DismissalTracker();
    setDismissalTracker(tracker);
    knownJsonlFiles = new PathSet();
    agents = new AgentStateStore();
  });

  afterEach(() => {
    for (const w of timers.fileWatchers.values()) w.close();
    for (const t of timers.polling.values()) clearInterval(t);
    for (const t of timers.waiting.values()) clearTimeout(t);
    for (const t of timers.permission.values()) clearTimeout(t);
    timers.fileWatchers.clear();
    timers.polling.clear();
    timers.waiting.clear();
    timers.permission.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('without a registry, a quiet transcript is not adopted (previous behaviour)', () => {
    setHookProvider(provider(undefined));
    staleTranscript('sess-a');
    scan();
    expect(agents.size).toBe(0);
  });

  it('adopts a quiet transcript whose session is running', () => {
    setHookProvider(provider([{ sessionId: 'sess-a', pid: 1, status: 'idle' }]));
    staleTranscript('sess-a');
    scan();
    expect(agents.size).toBe(1);
  });

  it('does not adopt a quiet transcript whose session is not running', () => {
    setHookProvider(provider([{ sessionId: 'someone-else', pid: 1 }]));
    staleTranscript('sess-a');
    scan();
    expect(agents.size).toBe(0);
  });

  it('does not bring back a running session the user already closed, even after the cooldown', () => {
    setHookProvider(provider([{ sessionId: 'sess-a', pid: 1, status: 'idle' }]));
    const file = staleTranscript('sess-a');
    tracker.dismiss(file, Date.now() - 60 * 60 * 1000); // long past the cooldown
    scan();
    expect(agents.size).toBe(0);
  });

  it('tells the office a busy session is active right after adopting it', () => {
    setHookProvider(provider([{ sessionId: 'sess-a', pid: 1, status: 'busy' }]));
    staleTranscript('sess-a');
    const messages: Array<Record<string, unknown>> = [];
    agents.on('broadcast', (m: Record<string, unknown>) => messages.push(m));
    scan();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'active' }),
    );
  });

  it('says nothing about activity for an idle session (the office starts it at rest)', () => {
    setHookProvider(provider([{ sessionId: 'sess-a', pid: 1, status: 'idle' }]));
    staleTranscript('sess-a');
    const messages: Array<Record<string, unknown>> = [];
    agents.on('broadcast', (m: Record<string, unknown>) => messages.push(m));
    scan();
    expect(messages.filter((m) => m.type === 'agentStatus')).toEqual([]);
  });
});
