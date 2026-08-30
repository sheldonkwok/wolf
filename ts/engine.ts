// Typed facade over the generated napi addon: real discriminated unions for the
// resolve outcomes, and a GameError class reconstructed from the thrown message.

import {
  Game,
  Rng,
  timeSeed,
  type DayResult,
  type GameState,
  type NightResult,
  type PlayerView,
  type Role,
  type VoteView,
  type Winner,
} from "./native/index.js";

export { Game, Rng, timeSeed };
export type { DayResult, GameState, NightResult, PlayerView, Role, VoteView, Winner };

// Stable tags mirrored from wolf::GameError::code in the engine crate.
export type GameErrorCode =
  | "TooFewPlayers"
  | "InvalidRoster"
  | "UnknownPlayer"
  | "PlayerNotAlive"
  | "NotAWerewolf"
  | "WrongPhase"
  | "AlreadyActed"
  | "ActionsIncomplete"
  | "GameOver"
  | "Unknown";

// The addon throws `Error("<Code>: <message>")`; this splits it back apart.
export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }

  static fromThrown(thrown: unknown): GameError {
    const raw = thrown instanceof Error ? thrown.message : String(thrown);
    const split = raw.indexOf(": ");
    if (split > 0) {
      return new GameError(raw.slice(0, split) as GameErrorCode, raw.slice(split + 2));
    }
    return new GameError("Unknown", raw);
  }
}

// Run an engine call, rethrowing any addon failure as a typed GameError.
export function attempt<T>(call: () => T): T {
  try {
    return call();
  } catch (thrown) {
    throw GameError.fromThrown(thrown);
  }
}

export type NightResolution =
  | { kind: "Killed"; killed: number }
  | { kind: "NoConsensus"; targets: number[] };

export type DayResolution =
  | { kind: "Eliminated"; eliminated: number }
  | { kind: "NoElimination" };

export function normalizeNight(result: NightResult): NightResolution {
  return result.kind === "Killed"
    ? { kind: "Killed", killed: result.killed ?? 0 }
    : { kind: "NoConsensus", targets: result.targets };
}

export function normalizeDay(result: DayResult): DayResolution {
  return result.kind === "Eliminated"
    ? { kind: "Eliminated", eliminated: result.eliminated ?? 0 }
    : { kind: "NoElimination" };
}
