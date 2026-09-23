// The pre-game roster: people join in order, the first is the host, and only the
// host may start the engine the lobby then owns. Ported from the old Rust `wolf::Lobby`.

import { Game } from "./engine.js";

// An opaque platform user handle, such as a Slack or Discord user id; the key that identifies a member.
export type UserId = string;

// One person in a lobby: the id is their identity, the name is a cosmetic label that may repeat or change.
export interface Member {
  readonly user: UserId;
  readonly name: string;
}

// Whether the lobby is still gathering players or has a game running.
export type LobbyState = "Waiting" | "InGame";

export type LobbyErrorCode =
  | "AlreadyJoined"
  | "NotInLobby"
  | "LobbyFull"
  | "NotHost"
  | "GameInProgress"
  | "NoGame"
  | "GameNotOver"
  | "TooFewPlayers";

// Thrown by join, leave, and the start/end commands; on throw the lobby is unchanged.
export class LobbyError extends Error {
  readonly code: LobbyErrorCode;

  constructor(code: LobbyErrorCode, message: string) {
    super(message);
    this.name = "LobbyError";
    this.code = code;
  }
}

export class Lobby {
  // Matches wolf::Engine::MIN_PLAYERS.
  static readonly MIN_PLAYERS = 5;
  // The most members a lobby holds, matching the top of the rules' player table.
  static readonly MAX_PLAYERS = 12;

  // Members in join order; members[0] is the host and the index is the seat.
  private readonly roster: Member[] = [];
  private running: Game | null = null;

  // ----- commands ---------------------------------------------------------

  // Add `user` under display name `name`; the first to join becomes the host.
  join(user: UserId, name: string): void {
    if (this.running) throw new LobbyError("GameInProgress", "a game is already in progress");
    if (this.contains(user)) {
      throw new LobbyError("AlreadyJoined", `user ${user} is already in the lobby`);
    }
    if (this.roster.length >= Lobby.MAX_PLAYERS) {
      throw new LobbyError("LobbyFull", `the lobby is full at ${Lobby.MAX_PLAYERS} players`);
    }
    this.roster.push({ user, name });
  }

  // Remove `user`; if they were the host, the next longest-waiting member is promoted.
  leave(user: UserId): void {
    if (this.running) throw new LobbyError("GameInProgress", "a game is already in progress");
    const seat = this.indexOf(user);
    if (seat === undefined) {
      throw new LobbyError("NotInLobby", `user ${user} is not in the lobby`);
    }
    this.roster.splice(seat, 1);
  }

  // Start a game with random roles, seeded from the clock; only the host may call this.
  start(host: UserId): Game {
    this.checkCanStart(host);
    this.running = new Game(this.roster.length);
    return this.running;
  }

  // Like start, but the deal is drawn from `seed` so the game can be reproduced.
  startWithSeed(host: UserId, seed: bigint): Game {
    this.checkCanStart(host);
    this.running = Game.withSeed(this.roster.length, seed);
    return this.running;
  }

  // Cancel a game at the host's request, keeping members intact.
  cancelGame(host: UserId): void {
    if (!this.isHost(host)) throw new LobbyError("NotHost", "Only the host can end the game.");
    if (!this.running) throw new LobbyError("NoGame", "there is no game running");
    this.running = null;
  }

  // Clear a finished game and return to Waiting with the members intact.
  endGame(): void {
    if (!this.running) throw new LobbyError("NoGame", "there is no game running");
    if (!this.running.state().isOver) {
      throw new LobbyError("GameNotOver", "the game is not over yet");
    }
    this.running = null;
  }

  // ----- inspection -----------------------------------------------------

  // Whether the lobby is waiting for players or running a game.
  get state(): LobbyState {
    return this.running ? "InGame" : "Waiting";
  }

  // The running game, or null while the lobby is waiting.
  get game(): Game | null {
    return this.running;
  }

  // Every member, in join order; a member's index is their seat in the game.
  get members(): readonly Member[] {
    return this.roster;
  }

  // How many members are in the lobby.
  get size(): number {
    return this.roster.length;
  }

  // Whether the lobby has no members.
  get isEmpty(): boolean {
    return this.roster.length === 0;
  }

  // The host, or null if the lobby is empty.
  get host(): Member | null {
    return this.roster[0] ?? null;
  }

  // Whether `user` is the current host.
  isHost(user: UserId): boolean {
    return this.host?.user === user;
  }

  // Whether `user` is a member of the lobby.
  contains(user: UserId): boolean {
    return this.indexOf(user) !== undefined;
  }

  // The seat `user` holds, or null if they are not a member; provisional until a game starts.
  seatOf(user: UserId): number | null {
    const seat = this.indexOf(user);
    return seat === undefined ? null : seat;
  }

  // The member sitting in `seat`, or null if the seat is out of range.
  memberAt(seat: number): Member | null {
    return this.roster[seat] ?? null;
  }

  // Whether the host could start a game right now.
  get canStart(): boolean {
    return !this.running && this.roster.length >= Lobby.MIN_PLAYERS;
  }

  // ----- internals -----------------------------------------------------

  private indexOf(user: UserId): number | undefined {
    const seat = this.roster.findIndex((m) => m.user === user);
    return seat === -1 ? undefined : seat;
  }

  // The shared gate for both start paths: no game running, caller is host, enough members.
  private checkCanStart(host: UserId): void {
    if (this.running) throw new LobbyError("GameInProgress", "a game is already in progress");
    if (!this.isHost(host)) {
      throw new LobbyError("NotHost", `user ${host} is not the host`);
    }
    if (this.roster.length < Lobby.MIN_PLAYERS) {
      throw new LobbyError(
        "TooFewPlayers",
        `need at least ${Lobby.MIN_PLAYERS} players, got ${this.roster.length}`,
      );
    }
  }
}
