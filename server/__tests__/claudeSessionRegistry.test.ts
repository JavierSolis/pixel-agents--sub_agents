import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLiveSessions } from '../src/providers/hook/claude/claudeSessionRegistry.js';

/** A pid that belonged to a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('readLiveSessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-registry-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(pid: number, body: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...body }));
  }

  it('returns null when the directory does not exist (no registry, not "nothing running")', () => {
    expect(readLiveSessions(path.join(dir, 'missing'))).toBeNull();
  });

  it('returns an empty list for an empty registry', () => {
    expect(readLiveSessions(dir)).toEqual([]);
  });

  it('reads sessionId, cwd and status of a running process', () => {
    record(process.pid, { sessionId: 'abc', cwd: '/work/x', status: 'busy' });
    expect(readLiveSessions(dir)).toEqual([
      { sessionId: 'abc', pid: process.pid, cwd: '/work/x', status: 'busy' },
    ]);
  });

  it('drops records whose process has exited', () => {
    record(process.pid, { sessionId: 'alive' });
    record(deadPid(), { sessionId: 'dead' });
    expect(readLiveSessions(dir)?.map((s) => s.sessionId)).toEqual(['alive']);
  });

  it('skips malformed records and records without a sessionId, keeping the rest', () => {
    fs.writeFileSync(path.join(dir, '111.json'), '{not json');
    record(process.pid, { cwd: '/no/session/id' });
    record(process.pid + 1_000_000, { sessionId: 'whatever' });
    expect(readLiveSessions(dir)).toEqual([]);
  });

  it('never opens the .key files that sit beside the records', () => {
    record(process.pid, { sessionId: 'abc' });
    // A directory named like a key file would make any read of it throw EISDIR; if the
    // reader touched it, the result below would change or the call would throw.
    fs.mkdirSync(path.join(dir, `${process.pid}.deadbeef.key`));
    expect(readLiveSessions(dir)?.map((s) => s.sessionId)).toEqual(['abc']);
  });

  it('leaves status undefined when the record has none', () => {
    record(process.pid, { sessionId: 'abc' });
    expect(readLiveSessions(dir)?.[0].status).toBeUndefined();
  });
});
