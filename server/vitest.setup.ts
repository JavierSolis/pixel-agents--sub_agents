import * as os from 'os';
import * as path from 'path';

// Never read the developer's real Claude session registry from a test: whatever
// sessions happen to be running on the machine would change what restores. A path
// that does not exist reads as "no registry", the same as a CLI that has none.
process.env['PIXEL_AGENTS_CLAUDE_SESSIONS_DIR'] ??= path.join(
  os.tmpdir(),
  'pixel-agents-tests-no-claude-session-registry',
);
