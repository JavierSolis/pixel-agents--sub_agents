/**
 * Restored agents start resting, live-created agents start working.
 *
 * The server replays only live tools and the waiting flag when a client connects, so
 * a session that was already quiet never sends a status event. If it started "active"
 * it would sit typing indefinitely and never walk to the lounge.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

test('a restored agent (no spawn effect) starts inactive', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  assert.equal(os.characters.get(1)?.isActive, false);
});

test('a freshly created agent (spawn effect) starts active', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(2, 0, 0);
  assert.equal(os.characters.get(2)?.isActive, true);
});

test('a replayed tool start flips a restored agent back to active', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(3, 0, 0, undefined, true);
  os.setAgentActive(3, true);
  assert.equal(os.characters.get(3)?.isActive, true);
});
