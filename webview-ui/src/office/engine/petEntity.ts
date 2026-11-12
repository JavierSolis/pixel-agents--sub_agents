import {
  PET_AFFINITY_ACTIVE,
  PET_AFFINITY_IDLE_MAX,
  PET_AFFINITY_IDLE_MIN,
  PET_AFFINITY_IDLE_RAMP_SEC,
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_FOLLOW_DURATION_MIN_SEC,
  PET_FOLLOW_RADIUS_TILES,
  PET_FOLLOW_RECALC_INTERVAL_SEC,
  PET_HUE_CANDIDATE_COUNT,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_IDLE_SEQUENCE,
  PET_TINT_MIN_LIGHTNESS,
  PET_TINT_MIN_SATURATION,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WALK_SEQUENCE,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { tintSprite } from '../colorize.js';
import { findPath, isWalkable } from '../layout/tileMap.js';
import type { PetSpriteFrames } from '../sprites/petSpriteData.js';
import type { Character, Pet, SpriteData, TileType as TileTypeVal } from '../types.js';
import { Direction, PetState, TILE_SIZE } from '../types.js';

/** Inclusive-min / exclusive-max random float */
function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

/** Manhattan distance between two tile coords */
function manhattanDistance(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

/**
 * How drawn a pet is to a character, as a probability in (0, 1): going to it when
 * apart, staying beside it when already there. Working agents get a small constant;
 * idle agents ramp linearly with how long they have been idle, up to a cap below 1.
 */
function petAffinity(ch: Character): number {
  if (ch.isActive) return PET_AFFINITY_ACTIVE;
  const ramp = Math.min((ch.idleSeconds ?? 0) / PET_AFFINITY_IDLE_RAMP_SEC, 1);
  return PET_AFFINITY_IDLE_MIN + (PET_AFFINITY_IDLE_MAX - PET_AFFINITY_IDLE_MIN) * ramp;
}

/**
 * Characters within PET_FOLLOW_RADIUS_TILES (Manhattan) that a pet may visit.
 * Excludes sub-agents and despawning characters (matrixEffect === 'despawn').
 */
function findNearbyCharacters(pet: Pet, characters: Map<number, Character>): Character[] {
  const nearby: Character[] = [];
  for (const ch of characters.values()) {
    if (ch.isSubagent || ch.matrixEffect === 'despawn') continue;
    const d = manhattanDistance(pet.tileCol, pet.tileRow, ch.tileCol, ch.tileRow);
    if (d <= PET_FOLLOW_RADIUS_TILES) nearby.push(ch);
  }
  return nearby;
}

/** Weighted random pick by `petAffinity`; consumes exactly one `Math.random()` call. */
function pickByAffinity(candidates: Character[]): Character {
  const total = candidates.reduce((sum, ch) => sum + petAffinity(ch), 0);
  let roll = Math.random() * total;
  for (const ch of candidates) {
    roll -= petAffinity(ch);
    if (roll < 0) return ch;
  }
  return candidates[candidates.length - 1];
}

/**
 * Find a walkable tile adjacent (4-connected) to a character's current tile.
 * Returns the first hit in N/S/W/E scan order, or null if all neighbours are blocked.
 */
function findAdjacentTile(
  ch: Character,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  const candidates = [
    { col: ch.tileCol, row: ch.tileRow - 1 },
    { col: ch.tileCol, row: ch.tileRow + 1 },
    { col: ch.tileCol - 1, row: ch.tileRow },
    { col: ch.tileCol + 1, row: ch.tileRow },
  ];
  for (const t of candidates) {
    if (isWalkable(t.col, t.row, tileMap, blockedTiles)) return t;
  }
  return null;
}

/** Advance the walk-cycle frame counter (4-step cycle). */
function updateWalkAnimation(pet: Pet, dt: number): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= PET_WALK_FRAME_DURATION_SEC) {
    pet.frameTimer -= PET_WALK_FRAME_DURATION_SEC;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/** Advance the idle-cycle frame counter (4-step cycle, slower than walk). */
function updateIdleAnimation(pet: Pet, dt: number): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= PET_IDLE_FRAME_DURATION_SEC) {
    pet.frameTimer -= PET_IDLE_FRAME_DURATION_SEC;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/**
 * Lerp the pet along its current `path`. When it reaches the next tile,
 * shift the tile off the path and update `tileCol`/`tileRow`. Sets `dir`.
 */
function movePetAlongPath(pet: Pet, dt: number): void {
  if (pet.path.length === 0) return;
  const nextTile = pet.path[0];
  pet.dir = directionBetween(pet.tileCol, pet.tileRow, nextTile.col, nextTile.row);

  pet.moveProgress += (PET_WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

  const fromCenter = tileCenter(pet.tileCol, pet.tileRow);
  const toCenter = tileCenter(nextTile.col, nextTile.row);
  const t = Math.min(pet.moveProgress, 1);
  pet.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
  pet.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

  if (pet.moveProgress >= 1) {
    pet.tileCol = nextTile.col;
    pet.tileRow = nextTile.row;
    pet.x = toCenter.x;
    pet.y = toCenter.y;
    pet.path.shift();
    pet.moveProgress = 0;
  }
}

/** Build a fresh pet at a tile with the IDLE FSM entry point. */
export function createPet(
  id: string,
  petType: number,
  col: number,
  row: number,
  hueShift = 0,
): Pet {
  const center = tileCenter(col, row);
  return {
    id,
    name: '', // Filled by OfficeState.addPet() via getPetName(petType)
    petType,
    hueShift,
    state: PetState.IDLE,
    dir: Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC),
    followTargetId: null,
    followRecalcTimer: 0,
    followDuration: 0,
    followDurationLimit: 0,
    bubbleType: null,
    bubbleTimer: 0,
  };
}

/**
 * Tick the pet's FSM by `dt` seconds. Mutates `pet` in place.
 * `walkableTiles`/`characters`/`tileMap`/`blockedTiles` are read-only inputs.
 */
export function updatePet(
  pet: Pet,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  characters: Map<number, Character>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  switch (pet.state) {
    case PetState.IDLE: {
      updateIdleAnimation(pet, dt);
      pet.wanderTimer -= dt;
      if (pet.wanderTimer > 0) break;

      // Cat-like: pets drift on their own, but are drawn to whoever is nearby and
      // still. Pick a candidate weighted by affinity, then roll against that
      // affinity — long-idle agents are both chosen more and kept company longer.
      const nearby = findNearbyCharacters(pet, characters);
      if (nearby.length > 0) {
        const target = pickByAffinity(nearby);
        if (Math.random() < petAffinity(target)) {
          const dist = manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
          if (dist <= 1) {
            // Already beside it: stay put, facing it, until the next decision.
            if (dist === 1) {
              pet.dir = directionBetween(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
            }
            pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
            break;
          }
          pet.state = PetState.FOLLOW;
          pet.followTargetId = target.id;
          pet.followDuration = 0;
          pet.followRecalcTimer = 0;
          pet.followDurationLimit = randomRange(
            PET_FOLLOW_DURATION_MIN_SEC,
            PET_FOLLOW_DURATION_MAX_SEC,
          );
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
      }

      // Else pick a random walkable tile (not own) and try to walk there
      if (walkableTiles.length > 0) {
        // Filter out own tile to avoid zero-length paths
        const candidates = walkableTiles.filter(
          (t) => t.col !== pet.tileCol || t.row !== pet.tileRow,
        );
        if (candidates.length > 0) {
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          const path = findPath(
            pet.tileCol,
            pet.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            pet.state = PetState.WALK;
            pet.path = path;
            pet.moveProgress = 0;
            pet.frame = 0;
            pet.frameTimer = 0;
          }
        }
      }
      pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
      break;
    }

    case PetState.WALK: {
      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);

      if (pet.path.length === 0 && pet.moveProgress === 0) {
        // Arrived
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.FOLLOW: {
      pet.followDuration += dt;
      const target = pet.followTargetId !== null ? characters.get(pet.followTargetId) : undefined;

      // Exit: target gone
      if (!target) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Exit: duration limit
      if (pet.followDuration >= pet.followDurationLimit) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Exit: reached target (Manhattan distance ≤ 1)
      const dist = manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
      if (dist <= 1) {
        // Face the target before settling
        if (dist === 1) {
          pet.dir = directionBetween(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
        }
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC);
        break;
      }

      // Continue following: recompute path periodically
      pet.followRecalcTimer -= dt;
      if (pet.followRecalcTimer <= 0) {
        const adj = findAdjacentTile(target, tileMap, blockedTiles);
        if (adj) {
          const path = findPath(pet.tileCol, pet.tileRow, adj.col, adj.row, tileMap, blockedTiles);
          if (path.length > 0) {
            pet.path = path;
            pet.moveProgress = 0;
          }
        }
        pet.followRecalcTimer = PET_FOLLOW_RECALC_INTERVAL_SEC;
      }

      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);
      break;
    }
  }
}

/** Smallest angular distance (degrees, 0-180) between two hues. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Pick a random tint (degrees in [1, 360)) for a new pet. 0 is reserved for "original
 * sprite colors" (what layouts saved before pet colors existed resolve to), so it is
 * never produced unless `keepFirstOriginal` is set and no pet of the type exists yet.
 * To avoid look-alikes, several random candidates are drawn and the one farthest from
 * every tone in `usedShifts` (tones of pets of the same type) is returned.
 * `random` is injectable (returns [0, 1)) for deterministic tests.
 */
export function pickPetHueShift(
  usedShifts: number[],
  random: () => number = Math.random,
  keepFirstOriginal = false,
): number {
  if (keepFirstOriginal && usedShifts.length === 0) return 0;
  const used = usedShifts.filter((h) => h !== 0);
  let best = 1;
  let bestDistance = -1;
  for (let i = 0; i < PET_HUE_CANDIDATE_COUNT; i++) {
    const candidate = 1 + Math.floor(random() * 359);
    const distance =
      used.length === 0 ? 180 : Math.min(...used.map((h) => hueDistance(candidate, h)));
    if (distance > bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Normalize a persisted hue to [0, 360); non-finite values (corrupt layouts) become 0. */
export function normalizePetHueShift(hue: unknown): number {
  if (typeof hue !== 'number' || !Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

/**
 * Tinted copies of base sprites, keyed by sprite identity then hue. Base frames
 * are stable objects, so each (frame, hue) pair is computed once.
 */
const hueShiftedSprites = new WeakMap<SpriteData, Map<number, SpriteData>>();

function applyHueShift(sprite: SpriteData, hueShift: number): SpriteData {
  if (hueShift === 0) return sprite;
  let byHue = hueShiftedSprites.get(sprite);
  if (!byHue) {
    byHue = new Map();
    hueShiftedSprites.set(sprite, byHue);
  }
  let shifted = byHue.get(hueShift);
  if (!shifted) {
    shifted = tintSprite(sprite, hueShift, PET_TINT_MIN_SATURATION, PET_TINT_MIN_LIGHTNESS);
    byHue.set(hueShift, shifted);
  }
  return shifted;
}

/**
 * Resolve the sprite for the pet's current state + direction + frame, with the
 * pet's hue shift applied. Returns null when sprites haven't loaded yet — renderer guards.
 */
export function getPetSpriteData(pet: Pet, petSprites: PetSpriteFrames | null): SpriteData | null {
  const base = getPetBaseSprite(pet, petSprites);
  return base ? applyHueShift(base, pet.hueShift) : null;
}

function getPetBaseSprite(pet: Pet, petSprites: PetSpriteFrames | null): SpriteData | null {
  if (!petSprites) return null;

  if (pet.state === PetState.IDLE) {
    const frameIdx = PET_IDLE_SEQUENCE[pet.frame % PET_IDLE_SEQUENCE.length];
    switch (pet.dir) {
      case Direction.DOWN:
        return petSprites.idleDown[frameIdx];
      case Direction.UP:
        return petSprites.idleUp[frameIdx];
      case Direction.RIGHT:
        return petSprites.idleRight[frameIdx];
      case Direction.LEFT:
        return petSprites.idleLeft[frameIdx];
    }
  }

  // WALK or FOLLOW
  const frameIdx = PET_WALK_SEQUENCE[pet.frame % PET_WALK_SEQUENCE.length];
  switch (pet.dir) {
    case Direction.DOWN:
      return petSprites.walkDown[frameIdx];
    case Direction.UP:
      return petSprites.walkUp[frameIdx];
    case Direction.RIGHT:
      return petSprites.walkRight[frameIdx];
    case Direction.LEFT:
      return petSprites.walkLeft[frameIdx];
  }
}
