import { describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';

/**
 * On connect the office learns which agents are working. A session the CLI reports
 * as busy but that has no tool in flight (e.g. mid-thought) would otherwise look
 * idle until its first tool starts.
 */
describe('resendAgentActivity with the CLI-reported status', () => {
  function collect(
    setup: (store: AgentStateStore) => void,
    liveStatusOf?: Parameters<typeof resendAgentActivity>[2],
  ): Array<Record<string, unknown>> {
    const store = new AgentStateStore();
    setup(store);
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => sent.push(m), store, liveStatusOf);
    return sent.filter((m) => m.type === 'agentStatus');
  }

  const agent = (id: number) =>
    createAgentState({
      id,
      sessionId: `s${id}`,
      isExternal: true,
      projectDir: '/p',
      jsonlFile: '/p/x.jsonl',
    });

  it('marks a busy session with nothing else to show as active', () => {
    const sent = collect(
      (store) => store.set(1, agent(1)),
      () => 'busy',
    );
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'active' }]);
  });

  it('says nothing for an idle session', () => {
    const sent = collect(
      (store) => store.set(1, agent(1)),
      () => 'idle',
    );
    expect(sent).toEqual([]);
  });

  it('does not treat the "shell" status as busy', () => {
    const sent = collect(
      (store) => store.set(1, agent(1)),
      () => 'shell',
    );
    expect(sent).toEqual([]);
  });

  it('keeps reporting waiting when the turn already ended, whatever the registry says', () => {
    const sent = collect(
      (store) => {
        const a = agent(1);
        a.isWaiting = true;
        store.set(1, a);
      },
      () => 'busy',
    );
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting' }]);
  });

  it('adds no extra status when a tool is in flight (its own replay already activates it)', () => {
    const sent = collect(
      (store) => {
        const a = agent(1);
        a.activeToolStatuses.set('t1', 'Reading x');
        store.set(1, a);
      },
      () => 'busy',
    );
    expect(sent).toEqual([]);
  });

  it('is unchanged when no lookup is given', () => {
    const sent = collect((store) => store.set(1, agent(1)));
    expect(sent).toEqual([]);
  });
});
