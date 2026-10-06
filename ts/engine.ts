// Typed game API over the native addon; error conversion and result validation stay here.

import {
  type DayResult,
  type GameState,
  type InspectionView,
  MIN_PLAYERS,
  Game as NativeGame,
  type GameErrorCode as NativeGameErrorCode,
  type NightResult,
  type PlayerView,
  Rng,
  type Role,
  timeSeed,
  type VoteView,
  type Winner,
} from "./native/index.js";

export type { GameState, InspectionView, PlayerView, Role, VoteView, Winner };
export { MIN_PLAYERS, Rng, timeSeed };

// Typed against the addon's generated union, so a code added in Rust fails typecheck until listed here.
const GAME_ERROR_CODES: Record<NativeGameErrorCode, true> = {
  TooFewPlayers: true,
  InvalidRoster: true,
  UnknownPlayer: true,
  PlayerNotAlive: true,
  NotAWerewolf: true,
  NotADoctor: true,
  NotASeer: true,
  NotPendingHunter: true,
  LastWolfCannotTargetSelf: true,
  WrongPhase: true,
  AlreadyActed: true,
  NoMajority: true,
  ActionsIncomplete: true,
  GameOver: true,
};

export type GameErrorCode = NativeGameErrorCode | "Unknown";

// The addon throws `Error("<Code>: <message>")`; this splits it back apart.
export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }

  static fromThrown(thrown: unknown): GameError {
    if (thrown instanceof GameError) return thrown;
    const raw = thrown instanceof Error ? thrown.message : String(thrown);
    const split = raw.indexOf(": ");
    if (split > 0) {
      const code = raw.slice(0, split);
      if (Object.hasOwn(GAME_ERROR_CODES, code))
        return new GameError(code as NativeGameErrorCode, raw.slice(split + 2));
    }
    return new GameError("Unknown", raw);
  }
}

// Run an engine call, rethrowing any addon failure as a typed GameError.
function attempt<T>(call: () => T): T {
  try {
    return call();
  } catch (thrown) {
    throw GameError.fromThrown(thrown);
  }
}

export type NightResolution =
  | { kind: "Killed"; killed: number }
  | { kind: "Saved"; saved: number }
  | { kind: "NoConsensus"; targets: number[] };

export type DayResolution = { kind: "Eliminated"; eliminated: number } | { kind: "Tied" };

function isSeat(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeNight(result: NightResult): NightResolution {
  if (result?.kind === "Killed" && isSeat(result.killed)) {
    return { kind: "Killed", killed: result.killed };
  }
  if (result?.kind === "Saved" && isSeat(result.saved)) {
    return { kind: "Saved", saved: result.saved };
  }
  if (result?.kind === "NoConsensus" && Array.isArray(result.targets) && result.targets.every(isSeat)) {
    return { kind: "NoConsensus", targets: result.targets };
  }
  throw new GameError("Unknown", "Invalid night resolution from native addon");
}

function normalizeDay(result: DayResult): DayResolution {
  if (result?.kind === "Tied" && result.eliminated == null) return { kind: "Tied" };
  if (result?.kind === "Eliminated" && isSeat(result.eliminated)) {
    return { kind: "Eliminated", eliminated: result.eliminated };
  }
  throw new GameError("Unknown", "Invalid day resolution from native addon");
}

export class Game {
  private inner: NativeGame;

  constructor(playerCount: number) {
    this.inner = attempt(() => new NativeGame(playerCount));
  }

  static withSeed(playerCount: number, seed: bigint): Game {
    return Game.fromNative(attempt(() => NativeGame.withSeed(playerCount, seed)));
  }

  static withRoles(roles: Role[]): Game {
    return Game.fromNative(attempt(() => NativeGame.withRoles(roles)));
  }

  // Wrap an existing native instance without constructing a second game or consuming randomness.
  private static fromNative(inner: NativeGame): Game {
    const game = Object.create(Game.prototype) as Game;
    game.inner = inner;
    return game;
  }

  nightAction(wolf: number, target: number): void {
    attempt(() => this.inner.nightAction(wolf, target));
  }

  doctorAction(doctor: number, target: number): void {
    attempt(() => this.inner.doctorAction(doctor, target));
  }

  seerAction(seer: number, target: number): InspectionView {
    return attempt(() => this.inner.seerAction(seer, target));
  }

  hunterAction(hunter: number, target: number): void {
    attempt(() => this.inner.hunterAction(hunter, target));
  }

  resolveNight(): NightResolution {
    return normalizeNight(attempt(() => this.inner.resolveNight()));
  }

  vote(voter: number, target: number): void {
    attempt(() => this.inner.vote(voter, target));
  }

  resolveDay(): DayResolution {
    return normalizeDay(attempt(() => this.inner.resolveDay()));
  }

  roleOf(id: number): Role {
    return attempt(() => this.inner.roleOf(id));
  }

  isAlive(id: number): boolean {
    return attempt(() => this.inner.isAlive(id));
  }

  state(): GameState {
    return attempt(() => this.inner.state());
  }
}
