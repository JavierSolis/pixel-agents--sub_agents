import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LiveSession } from '../../core/src/provider.js';
import type { AgentState } from './types.js';

/** Bytes read from the end of a transcript. Long sessions grow to tens of MB; the
 *  recent tail is what answers "what is this agent doing", and reading all of it
 *  on every refresh would be wasteful. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
/** Newest chat entries returned to the client. */
export const MAX_CHAT_ENTRIES = 400;
/** Longest text kept per chat entry; the rest is cut so one giant paste or tool
 *  dump cannot bloat the payload. */
export const MAX_ENTRY_CHARS = 6000;
/** Longest one-line summary of a tool call's input. */
const MAX_TOOL_SUMMARY_CHARS = 160;

/** Input fields that best describe a tool call, in order of preference. */
const TOOL_SUMMARY_KEYS = [
  'description',
  'command',
  'file_path',
  'pattern',
  'url',
  'query',
  'prompt',
];

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatEntry {
  role: ChatRole;
  text: string;
  /** ms since epoch; 0 when the record carried no parsable timestamp. */
  at: number;
}

export interface AgentDetailsPayload {
  /** False when the id is not a tracked agent (it closed between click and request). */
  found: boolean;
  sessionId?: string;
  /** Working directory the session runs in. */
  cwd?: string;
  /** PID of the CLI process, from the CLI's own registry; undefined when it is not running. */
  pid?: number;
  /** true = the registry lists a live process for this session; false = the registry
   *  exists and does not; null = this CLI exposes no registry, so liveness is unknown. */
  alive?: boolean | null;
  /** The CLI's own state label (idle / busy / shell ...) for the live process. */
  status?: string;
  /** When `status` last changed (ms since epoch). */
  statusSince?: number;
  /** When the process started (ms since epoch). */
  startedAt?: number;
  /** Timestamp of the newest transcript record (ms since epoch), 0 if none. */
  lastActivityAt?: number;
  agentName?: string;
  teamName?: string;
  isTeamLead?: boolean;
  contextTokens?: number;
  maxContextTokens?: number;
  /** Transcript file path, shown so the reader can open the raw log. */
  transcriptFile?: string;
  /** True when older records were left out (tail window or entry cap). */
  truncated?: boolean;
  chat?: ChatEntry[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Short one-line description of what a tool call does. */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(value.replace(/\s+/g, ' ').trim(), MAX_TOOL_SUMMARY_CHARS);
    }
  }
  return '';
}

/**
 * What a user record's text really is. Claude Code stores slash commands, hook
 * output and injected reminders as "user" records wrapped in pseudo-XML tags;
 * showing those raw would bury the actual conversation, so commands are reduced
 * to their name and everything else that is machinery returns null.
 */
function userVisibleText(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  if (/^<(local-command|command-message|system-reminder|task-notification)/.test(text)) {
    return null;
  }
  return text;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Turn transcript lines into a readable conversation. Sidechain records belong
 * to sub-agents, thinking blocks and tool results are noise for a "what is it
 * doing" view, and malformed lines (a record cut mid-write) are skipped.
 */
export function parseTranscriptChat(lines: string[]): {
  chat: ChatEntry[];
  lastActivityAt: number;
} {
  const chat: ChatEntry[] = [];
  let lastActivityAt = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = parseTimestamp(record.timestamp);
    if (at > lastActivityAt && (record.type === 'user' || record.type === 'assistant')) {
      lastActivityAt = at;
    }
    if (record.isSidechain === true || record.isMeta === true) continue;

    const message = record.message as { content?: unknown } | undefined;
    const content = message?.content;

    if (record.type === 'user') {
      if (typeof content === 'string') {
        const text = userVisibleText(content);
        if (text) chat.push({ role: 'user', text: clip(text, MAX_ENTRY_CHARS), at });
      } else if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = userVisibleText(block.text);
            if (text) chat.push({ role: 'user', text: clip(text, MAX_ENTRY_CHARS), at });
          }
        }
      }
    } else if (record.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          chat.push({ role: 'assistant', text: clip(block.text.trim(), MAX_ENTRY_CHARS), at });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const summary = summarizeToolInput(block.input);
          chat.push({ role: 'tool', text: summary ? `${block.name}: ${summary}` : block.name, at });
        }
      }
    }
  }

  return { chat, lastActivityAt };
}

/** Read the last `maxBytes` of a file as complete lines (a cut first line is dropped). */
export function readTranscriptTail(
  file: string,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): { lines: string[]; cutHead: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf-8').split('\n');
    // Starting mid-file lands inside a record: its first fragment is not valid JSON.
    if (start > 0) lines.shift();
    return { lines, cutHead: start > 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build the details dialog's payload for one agent: its process facts (from the
 * CLI's own registry, the same source of truth that decides who is really alive)
 * plus its recent conversation read from the transcript.
 *
 * `live` is the registry listing, or null when the CLI has no registry.
 */
export function buildAgentDetails(
  agent: AgentState | undefined,
  live: LiveSession[] | null,
): AgentDetailsPayload {
  if (!agent) return { found: false };

  const session =
    live?.find(
      (s) =>
        s.sessionId === agent.sessionId || s.sessionId === path.basename(agent.jsonlFile, '.jsonl'),
    ) ?? undefined;

  const payload: AgentDetailsPayload = {
    found: true,
    sessionId: agent.sessionId,
    cwd: session?.cwd ?? agent.projectDir,
    pid: session?.pid,
    alive: live === null ? null : session !== undefined,
    status: session?.status,
    statusSince: session?.statusUpdatedAt,
    startedAt: session?.startedAt,
    agentName: agent.agentName,
    teamName: agent.teamName,
    isTeamLead: agent.isTeamLead,
    contextTokens: agent.contextTokens,
    maxContextTokens: agent.maxContextTokens,
    transcriptFile: agent.jsonlFile,
    chat: [],
    lastActivityAt: 0,
  };

  if (agent.jsonlFile) {
    const tail = readTranscriptTail(agent.jsonlFile);
    if (tail) {
      const { chat, lastActivityAt } = parseTranscriptChat(tail.lines);
      payload.lastActivityAt = lastActivityAt;
      payload.truncated = tail.cutHead || chat.length > MAX_CHAT_ENTRIES;
      payload.chat = chat.slice(-MAX_CHAT_ENTRIES);
    }
  }
  return payload;
}
