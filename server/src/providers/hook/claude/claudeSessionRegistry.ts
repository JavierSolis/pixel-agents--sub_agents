import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { LiveSession } from '../../../../../core/src/provider.js';

/**
 * Claude Code keeps one record per running process in ~/.claude/sessions/<pid>.json
 * (pid, sessionId, cwd and a status label such as idle / busy). The format is the
 * CLI's own and undocumented, so everything here is defensive: an unreadable
 * directory is "no registry" (null), never "no sessions", and one malformed record
 * only costs that record.
 */
const SESSIONS_DIR_ENV = 'PIXEL_AGENTS_CLAUDE_SESSIONS_DIR';

/** The registry directory. The environment variable moves it away from the real
 *  home, which is how tests keep a developer's running sessions out of their results. */
function defaultSessionsDir(): string {
  return process.env[SESSIONS_DIR_ENV] || path.join(os.homedir(), '.claude', 'sessions');
}

/** True when a process with this pid exists. EPERM means it exists but belongs to
 *  someone else, which still counts as alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the registry and return the sessions whose process is alive. Returns null
 * when the directory is missing or unreadable, so the caller can tell "this CLI
 * version has no registry" apart from "nothing is running".
 *
 * Only `<pid>.json` files are read; the sibling `.key` files hold credentials and
 * are never opened.
 */
export function readLiveSessions(dir: string = defaultSessionsDir()): LiveSession[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const live: LiveSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as Record<
        string,
        unknown
      >;
      const pid = typeof raw.pid === 'number' ? raw.pid : Number.parseInt(name, 10);
      const sessionId = raw.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') continue;
      if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) continue;
      live.push({
        sessionId,
        pid,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        status: typeof raw.status === 'string' ? raw.status : undefined,
      });
    } catch {
      /* malformed or half-written record: skip it */
    }
  }
  return live;
}
