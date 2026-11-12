import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LiveSession } from '../../core/src/provider.js';
import {
  buildAgentDetails,
  MAX_ENTRY_CHARS,
  parseTranscriptChat,
  readTranscriptTail,
} from '../src/agentDetails.js';
import type { AgentState } from '../src/types.js';

const line = (record: Record<string, unknown>) => JSON.stringify(record);

describe('parseTranscriptChat', () => {
  it('turns user text, assistant text and tool calls into chat entries', () => {
    const { chat, lastActivityAt } = parseTranscriptChat([
      line({
        type: 'user',
        timestamp: '2026-11-10T21:30:39.490Z',
        message: { content: 'hola, ¿cómo andamos?' },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-11-10T21:30:50.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Todo bien.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls   -la\n/tmp' } },
          ],
        },
      }),
    ]);

    expect(chat.map((e) => [e.role, e.text])).toEqual([
      ['user', 'hola, ¿cómo andamos?'],
      ['assistant', 'Todo bien.'],
      ['tool', 'Bash: ls -la /tmp'],
    ]);
    expect(lastActivityAt).toBe(Date.parse('2026-11-10T21:30:50.000Z'));
  });

  it('drops sidechain, meta, tool results, machinery tags and malformed lines', () => {
    const { chat } = parseTranscriptChat([
      line({ type: 'user', isSidechain: true, message: { content: 'de un sub-agente' } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'salida' }] },
      }),
      line({ type: 'user', message: { content: '<system-reminder>ruido</system-reminder>' } }),
      '{"type":"user","message":{"content":"cortado a la mitad',
      '',
      line({ type: 'system', subtype: 'turn_duration' }),
    ]);
    expect(chat).toEqual([]);
  });

  it('reduces a slash command to its name and arguments', () => {
    const { chat } = parseTranscriptChat([
      line({
        type: 'user',
        message: {
          content:
            '<command-message>x</command-message><command-name>/model</command-name><command-args>opus</command-args>',
        },
      }),
    ]);
    expect(chat[0]).toMatchObject({ role: 'user', text: '/model opus' });
  });

  it('reads text blocks inside array-form user content', () => {
    const { chat } = parseTranscriptChat([
      line({ type: 'user', message: { content: [{ type: 'text', text: 'con bloques' }] } }),
    ]);
    expect(chat[0]).toMatchObject({ role: 'user', text: 'con bloques' });
  });

  it('clips giant entries', () => {
    const { chat } = parseTranscriptChat([
      line({ type: 'user', message: { content: 'x'.repeat(MAX_ENTRY_CHARS + 500) } }),
    ]);
    expect(chat[0].text.length).toBe(MAX_ENTRY_CHARS + 1);
    expect(chat[0].text.endsWith('…')).toBe(true);
  });
});

describe('readTranscriptTail / buildAgentDetails', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-details-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const agent = (jsonlFile: string, sessionId = 'sess-1'): AgentState =>
    ({
      id: 7,
      sessionId,
      jsonlFile,
      projectDir: '/work/proj',
      contextTokens: 10,
      maxContextTokens: 100,
    }) as AgentState;

  it('drops the cut first line when it starts mid-file', () => {
    const file = path.join(dir, 's.jsonl');
    const a = line({ type: 'user', message: { content: 'primera' } });
    const b = line({ type: 'user', message: { content: 'segunda' } });
    fs.writeFileSync(file, `${a}\n${b}\n`);
    const tail = readTranscriptTail(file, b.length + 5);
    expect(tail?.cutHead).toBe(true);
    expect(tail?.lines.filter(Boolean)).toEqual([b]);
  });

  it('returns null for a missing transcript', () => {
    expect(readTranscriptTail(path.join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('reports not-found for an unknown agent', () => {
    expect(buildAgentDetails(undefined, [])).toEqual({ found: false });
  });

  it('joins the live registry entry by session id', () => {
    const file = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(file, `${line({ type: 'user', message: { content: 'hola' } })}\n`);
    const live: LiveSession[] = [
      {
        sessionId: 'sess-1',
        pid: 4242,
        cwd: '/work/proj',
        status: 'busy',
        startedAt: 1000,
        statusUpdatedAt: 2000,
      },
    ];
    const details = buildAgentDetails(agent(file), live);
    expect(details).toMatchObject({
      found: true,
      pid: 4242,
      alive: true,
      status: 'busy',
      statusSince: 2000,
      startedAt: 1000,
      cwd: '/work/proj',
    });
    expect(details.chat).toHaveLength(1);
  });

  it('distinguishes "not running" from "no registry"', () => {
    const file = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(file, '');
    expect(buildAgentDetails(agent(file), []).alive).toBe(false);
    expect(buildAgentDetails(agent(file), null).alive).toBeNull();
  });
});
