/**
 * Unit tests for the Pet FSM.
 *
 * Covers:
 *   - createPet initial state
 *   - IDLE → WALK transition (wanderTimer expiry + findPath succeeds)
 *   - IDLE → FOLLOW transition (when character nearby and affinity roll succeeds)
 *   - Affinity: sub-agents ignored, longest-idle agent preferred, working agents rarely
 *     visited, pets stay beside long-idle agents (several pets may share one)
 *   - WALK → IDLE on path exhaustion (resets frameTimer)
 *   - FOLLOW → IDLE when target despawns
 *   - FOLLOW → IDLE when duration limit reached
 *   - FOLLOW → IDLE when target reached (Manhattan distance ≤ 1)
 *   - Animation timer increments
 *   - Defensive: empty walkableTiles, etc.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import {
  PET_AFFINITY_ACTIVE,
  PET_AFFINITY_IDLE_RAMP_SEC,
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_TINT_MIN_LIGHTNESS,
  PET_TINT_MIN_SATURATION,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
} from '../src/constants.js';
import { tintSprite } from '../src/office/colorize.js';
import {
  createPet,
  getPetSpriteData,
  normalizePetHueShift,
  pickPetHueShift,
  updatePet,
} from '../src/office/engine/petEntity.js';
import type { Character, SpriteData, TileType as TileTypeVal } from '../src/office/types.js';
import { CharacterState, Direction, PetState, TileType } from '../src/office/types.js';

// ── Helpers ────────────────────────────────────────────────────

/** Build an all-FLOOR tile map of given dimensions. */
function buildOpenTileMap(cols: number, rows: number): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(TileType.FLOOR_1 as TileTypeVal);
    }
    map.push(row);
  }
  return map;
}

/** Build the walkableTiles index for a fully-open tileMap. */
function buildWalkableTiles(cols: number, rows: number): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c, row: r });
    }
  }
  return tiles;
}

/** Create a minimal Character stub (only fields the FSM reads). */
function makeChar(id: number, col: number, row: number): Character {
  return {
    id,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: col * 16 + 8,
    y: row * 16 + 8,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette: 0,
    hueShift: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: 5,
    isActive: false,
    seatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    contextTokens: 0,
    maxContextTokens: 200_000,
  };
}

// Math.random stubbing — single shared mock so we can drive deterministic decisions.
let randomQueue: number[] = [];
const realRandom = Math.random;

beforeEach(() => {
  randomQueue = [];
  Math.random = () => (randomQueue.length > 0 ? randomQueue.shift()! : 0.5);
});

afterEach(() => {
  Math.random = realRandom;
});

// ── createPet ──────────────────────────────────────────────────

test('createPet returns an IDLE pet at the tile center', () => {
  const pet = createPet('p1', 0, 3, 4);
  assert.equal(pet.id, 'p1');
  assert.equal(pet.petType, 0);
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.DOWN);
  assert.equal(pet.x, 3 * 16 + 8);
  assert.equal(pet.y, 4 * 16 + 8);
  assert.equal(pet.tileCol, 3);
  assert.equal(pet.tileRow, 4);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.bubbleType, null);
  assert.equal(pet.bubbleTimer, 0);
  // wanderTimer is randomized within [PET_WANDER_PAUSE_MIN_SEC, MAX]
  assert.ok(pet.wanderTimer > 0);
  assert.ok(pet.wanderTimer <= PET_WANDER_PAUSE_MAX_SEC);
});

// ── IDLE → WALK ───────────────────────────────────────────────

test('IDLE → WALK after wanderTimer expires (follow roll fails)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0.0001;
  // No character nearby → no follow roll; one roll picks the random walkable target
  // (Math.floor(0.0 * candidates.length) = first)
  randomQueue = [0.0];
  updatePet(pet, 0.1, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.WALK);
  assert.ok(pet.path.length > 0, 'expected non-empty path after IDLE→WALK');
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.frame, 0);
  assert.equal(pet.frameTimer, 0);
});

test('IDLE stays IDLE when wanderTimer > 0', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.wanderTimer = 10;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.ok(pet.wanderTimer < 10, 'wanderTimer should decrement by dt');
});

test('IDLE stays IDLE when walkableTiles is empty', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.wanderTimer = 0;
  updatePet(pet, 0.1, [], new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
});

// ── IDLE → FOLLOW ─────────────────────────────────────────────

test('IDLE → FOLLOW when character is nearby and affinity roll succeeds', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(42, 3, 3); // distance 2 (≤ PET_FOLLOW_RADIUS_TILES=3)
  const characters = new Map<number, Character>([[character.id, character]]);
  // Roll 1: weighted pick among candidates
  // Roll 2: affinity roll (0.0 < idle affinity → go)
  // Roll 3: followDurationLimit randomRange (0.5 → middle)
  randomQueue = [0.0, 0.0, 0.5];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, 42);
  assert.equal(pet.followDuration, 0);
  assert.equal(pet.followRecalcTimer, 0);
  assert.ok(
    pet.followDurationLimit > 0 && pet.followDurationLimit <= PET_FOLLOW_DURATION_MAX_SEC,
    'expected followDurationLimit within bounds',
  );
});

test('IDLE does NOT enter FOLLOW when no character is in range', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = createPet('p1', 0, 0, 0);
  pet.wanderTimer = 0;
  const farChar = makeChar(1, 9, 9); // distance 18, beyond radius 3
  const characters = new Map<number, Character>([[1, farChar]]);
  // No target in range → falls through to WALK
  randomQueue = [0.0, 0.0];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.notEqual(pet.state, PetState.FOLLOW);
});

test('IDLE skips despawning characters as follow targets', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(1, 3, 3);
  character.matrixEffect = 'despawn';
  const characters = new Map<number, Character>([[1, character]]);
  randomQueue = [0.0, 0.0]; // would enter follow if target found
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.notEqual(pet.state, PetState.FOLLOW);
});

test('IDLE never follows sub-agents', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const sub = makeChar(-1, 3, 3);
  sub.isSubagent = true;
  const characters = new Map<number, Character>([[sub.id, sub]]);
  randomQueue = [0.0, 0.0];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.notEqual(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, null);
});

test('IDLE prefers the agent that has been idle longest', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const fresh = makeChar(1, 1, 2);
  fresh.idleSeconds = 0; // affinity 0.15
  const bored = makeChar(2, 3, 3);
  bored.idleSeconds = PET_AFFINITY_IDLE_RAMP_SEC; // affinity 0.9
  const characters = new Map<number, Character>([
    [1, fresh],
    [2, bored],
  ]);
  // Weighted pick with 0.5 lands in the long-idle agent's share (0.9 of 1.05 total),
  // not in the fresh one's first 0.15.
  randomQueue = [0.5, 0.0, 0.5];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, 2);
});

test('IDLE rarely visits a working agent: roll above the active affinity is skipped', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const busy = makeChar(1, 3, 3);
  busy.isActive = true;
  const characters = new Map<number, Character>([[1, busy]]);
  // Pick, then affinity roll 0.5 > PET_AFFINITY_ACTIVE → wander instead.
  randomQueue = [0.0, 0.5, 0.0];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.WALK);
  assert.equal(pet.followTargetId, null);
});

test('IDLE visits a working agent when the roll is under the active affinity', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const busy = makeChar(1, 3, 3);
  busy.isActive = true;
  const characters = new Map<number, Character>([[1, busy]]);
  randomQueue = [0.0, PET_AFFINITY_ACTIVE / 2, 0.5];
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, 1);
});

test('IDLE stays beside a long-idle agent instead of wandering off (faces it)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const bored = makeChar(1, 3, 2); // adjacent, to the right
  bored.idleSeconds = PET_AFFINITY_IDLE_RAMP_SEC;
  const characters = new Map<number, Character>([[1, bored]]);
  randomQueue = [0.0, 0.5, 0.5]; // pick, affinity roll 0.5 < 0.9 → stay, timer
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.RIGHT);
  assert.equal(pet.tileCol, 2);
  assert.ok(pet.wanderTimer > 0, 'timer re-armed so it decides again later');
});

test('IDLE leaves a long-idle agent when the roll exceeds the capped affinity', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.wanderTimer = 0;
  const bored = makeChar(1, 3, 2);
  bored.idleSeconds = PET_AFFINITY_IDLE_RAMP_SEC * 10; // capped at the max
  const characters = new Map<number, Character>([[1, bored]]);
  randomQueue = [0.0, 0.95, 0.0]; // 0.95 > PET_AFFINITY_IDLE_MAX → wander
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.WALK);
});

test('several pets can stay beside the same idle agent', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const bored = makeChar(1, 2, 2);
  bored.idleSeconds = PET_AFFINITY_IDLE_RAMP_SEC;
  const characters = new Map<number, Character>([[1, bored]]);
  const petA = createPet('a', 0, 1, 2);
  const petB = createPet('b', 1, 3, 2);
  petA.wanderTimer = 0;
  petB.wanderTimer = 0;
  randomQueue = [0.0, 0.1, 0.5, 0.0, 0.1, 0.5];
  updatePet(petA, 0.1, walkable, characters, tileMap, new Set());
  updatePet(petB, 0.1, walkable, characters, tileMap, new Set());
  assert.equal(petA.state, PetState.IDLE);
  assert.equal(petB.state, PetState.IDLE);
  assert.equal(petA.dir, Direction.RIGHT);
  assert.equal(petB.dir, Direction.LEFT);
});

// ── WALK → IDLE ───────────────────────────────────────────────

test('WALK → IDLE when path exhausted (resets frameTimer)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.WALK;
  pet.path = []; // already empty → arrival branch
  pet.moveProgress = 0;
  pet.frameTimer = 0.123;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.frameTimer, 0, 'frameTimer must reset to 0 on WALK→IDLE');
  assert.equal(pet.frame, 0);
  assert.ok(pet.wanderTimer > 0);
});

// ── FOLLOW exits ──────────────────────────────────────────────

test('FOLLOW → IDLE when target despawns (no longer in characters map)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 99; // not in map
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.5;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.frameTimer, 0, 'frameTimer reset on FOLLOW→IDLE');
});

test('FOLLOW → IDLE when followDuration >= followDurationLimit', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 1;
  pet.followDuration = 10;
  pet.followDurationLimit = 5;
  pet.frameTimer = 0.7;
  const char = makeChar(1, 4, 4);
  const characters = new Map<number, Character>([[1, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.frameTimer, 0);
});

test('FOLLOW → IDLE when within Manhattan distance 1 of target (faces target)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 2, 2);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 7;
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.4;
  // Target is 1 tile to the right → pet faces RIGHT before settling.
  const char = makeChar(7, 3, 2);
  const characters = new Map<number, Character>([[7, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.RIGHT, 'should face target before settling');
  assert.equal(pet.frameTimer, 0);
});

// ── Animation timers ─────────────────────────────────────────

test('WALK animation: frameTimer wraps to 0 and frame increments after PET_WALK_FRAME_DURATION_SEC', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = createPet('p1', 0, 0, 0);
  pet.state = PetState.WALK;
  pet.path = [{ col: 1, row: 0 }]; // 1-tile path so it stays in WALK
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  // Run with dt slightly larger than the animation duration
  updatePet(pet, PET_WALK_FRAME_DURATION_SEC + 0.001, walkable, new Map(), tileMap, new Set());
  // frame should have advanced by 1 (4-step cycle).
  assert.equal(pet.frame, 1);
  // frameTimer should be small positive (the leftover after the threshold)
  assert.ok(pet.frameTimer >= 0 && pet.frameTimer < PET_WALK_FRAME_DURATION_SEC);
});

test('IDLE animation ticks while pet is in IDLE state', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.wanderTimer = 100; // ensures we stay in IDLE, no state transition
  pet.frame = 0;
  pet.frameTimer = 0;
  updatePet(pet, 0.5, walkable, new Map(), tileMap, new Set());
  // frame may or may not have ticked depending on PET_IDLE_FRAME_DURATION_SEC (=0.3)
  // 0.5s > 0.3s → frame increments by 1, frameTimer holds the remainder
  assert.equal(pet.frame, 1);
});

// ── Defensive / edge cases ────────────────────────────────────

test('updatePet does not throw on dt=0', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  assert.doesNotThrow(() => updatePet(pet, 0, walkable, new Map(), tileMap, new Set()));
});

test('updatePet handles FOLLOW with null followTargetId (defensive: never enter follow without setting id)', () => {
  // Synthetic: FOLLOW state with no target id. Should exit cleanly.
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = createPet('p1', 0, 1, 1);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = null;
  pet.followDurationLimit = 5;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set());
  assert.equal(pet.state, PetState.IDLE, 'no target → exit FOLLOW');
});

// ── Hue shift (per-instance color) ─────────────────────────────

test('createPet defaults hueShift to 0 and accepts an explicit one', () => {
  assert.equal(createPet('p1', 0, 0, 0).hueShift, 0);
  assert.equal(createPet('p2', 0, 0, 0, 180).hueShift, 180);
});

test('pickPetHueShift is random, never 0 by default, and driven by the injected random', () => {
  const low = pickPetHueShift([], () => 0);
  const high = pickPetHueShift([], () => 0.999);
  assert.equal(low, 1);
  assert.equal(high, 359);
  for (let i = 0; i < 200; i++) {
    const h = pickPetHueShift([], Math.random);
    assert.ok(h >= 1 && h < 360);
  }
});

test('pickPetHueShift keeps the original colors for the first pet only when asked', () => {
  assert.equal(
    pickPetHueShift([], () => 0.5, true),
    0,
  );
  assert.notEqual(
    pickPetHueShift([120], () => 0.5, true),
    0,
  );
});

test('pickPetHueShift prefers the candidate farthest from tones already in use', () => {
  // Candidates cycle 100, 200, 300 degrees ...; used tone is 110, so 300 (170 away) wins.
  const seq = [99 / 359, 199 / 359, 299 / 359];
  let i = 0;
  const random = () => seq[i++ % seq.length];
  assert.equal(pickPetHueShift([110], random), 300);
});

test('normalizePetHueShift: missing or corrupt values become 0, others wrap into [0, 360)', () => {
  assert.equal(normalizePetHueShift(undefined), 0);
  assert.equal(normalizePetHueShift(Number.NaN), 0);
  assert.equal(normalizePetHueShift('90'), 0);
  assert.equal(normalizePetHueShift(450), 90);
  assert.equal(normalizePetHueShift(-90), 270);
});

test('tintSprite gives clearly different colors to a nearly gray sprite and keeps alpha', () => {
  const gray: SpriteData = [[`#${'3E3636'}`, `#${'120E14'}`, '']];
  const a = tintSprite(gray, 30, PET_TINT_MIN_SATURATION, PET_TINT_MIN_LIGHTNESS);
  const b = tintSprite(gray, 200, PET_TINT_MIN_SATURATION, PET_TINT_MIN_LIGHTNESS);
  assert.notDeepEqual(a, gray);
  assert.notDeepEqual(a, b);
  assert.equal(a[0][2], '');
  const chroma = (px: string) => {
    const v = [1, 3, 5].map((k) => parseInt(px.slice(k, k + 2), 16));
    return Math.max(...v) - Math.min(...v);
  };
  assert.ok(chroma(a[0][0]) > 60, 'body pixel must show real chroma');
  assert.ok(chroma(a[0][1]) > 40, 'near-black pixel must show real chroma');
  const translucent = tintSprite([[`#${'3E363680'}`]], 30, 0.6, 0.2);
  assert.equal(translucent[0][0].slice(7), '80');
});

test('getPetSpriteData returns the base frame for hue 0 and a cached shifted copy otherwise', () => {
  const frame = (): SpriteData => [[`#${'ff0000'}`]];
  const triple = (): [SpriteData, SpriteData, SpriteData] => [frame(), frame(), frame()];
  const sprites = {
    walkDown: triple(),
    idleDown: triple(),
    walkUp: triple(),
    idleUp: triple(),
    walkRight: triple(),
    walkLeft: triple(),
    idleRight: triple(),
    idleLeft: triple(),
  };
  const original = createPet('a', 0, 0, 0);
  const shifted = createPet('b', 0, 0, 0, 180);
  const base = getPetSpriteData(original, sprites);
  assert.equal(base, sprites.idleDown[0]);
  const out = getPetSpriteData(shifted, sprites);
  assert.notEqual(out, base);
  assert.notDeepEqual(out, base);
  assert.equal(getPetSpriteData(shifted, sprites), out); // cached
});
