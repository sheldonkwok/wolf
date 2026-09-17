// The lobby: construction and host rules, join/leave paths, the start gate, the
// id-to-seat mapping, the in-game lockout, and clearing a finished game. Ported
// from the old Rust suites crates/wolf/src/lobby/tests.rs and tests/lobby.rs.

import { expect, test } from "bun:test";

import { type Game } from "./engine.js";
import { Lobby, LobbyError } from "./lobby.js";

// ----- helpers -----------------------------------------------------------

// A waiting lobby with `n` members whose ids and names are both u0..un.
function lobbyWith(n: number): Lobby {
  const lobby = new Lobby();
  for (let i = 0; i < n; i++) lobby.join(`u${i}`, `u${i}`);
  return lobby;
}

// Run a call that must throw and return it as a typed LobbyError.
function grab(call: () => unknown): LobbyError {
  try {
    call();
  } catch (thrown) {
    if (thrown instanceof LobbyError) return thrown;
    throw thrown;
  }
  throw new Error("expected the call to throw");
}

// Drive a running game to its end with an agreeing pack and a self-voting town.
function playOut(game: Game): void {
  const cap = game.state().players.length * 2 + 4;
  for (let i = 0; i < cap; i++) {
    const s = game.state();
    if (s.phase === "Ended") return;
    if (s.phase === "Night") {
      const victim = s.players.find((p) => p.alive && p.role === "Villager")!.id;
      const wolves = s.players.filter((p) => p.alive && p.role === "Werewolf").map((p) => p.id);
      for (const wolf of wolves) game.nightAction(wolf, victim);
      expect(game.resolveNight().kind).toBe("Killed");
    } else {
      const living = s.players.filter((p) => p.alive).map((p) => p.id);
      for (const player of living.slice(0, s.readinessRequired)) game.readyToVote(player);
      for (const voter of living) game.vote(voter, voter);
      expect(game.resolveDay().kind).toBe("NoElimination");
    }
  }
  throw new Error("game did not end within the phase cap");
}

// Every member is reachable by seat and the two lookups are exact inverses.
function assertMappingIsConsistent(lobby: Lobby, n: number): void {
  for (let i = 0; i < n; i++) {
    const id = `u${i}`;
    const seat = lobby.seatOf(id);
    expect(seat).toBe(i);
    expect(lobby.memberAt(seat!)!.user).toBe(id);
  }
}

// ----- construction & host --------------------------------------------

test("a new lobby is empty and waiting with no host", () => {
  const lobby = new Lobby();
  expect(lobby.isEmpty).toBe(true);
  expect(lobby.size).toBe(0);
  expect(lobby.state).toBe("Waiting");
  expect(lobby.host).toBeNull();
  expect(lobby.game).toBeNull();
});

test("the first member to join is the host", () => {
  const lobby = new Lobby();
  lobby.join("a", "Alice");
  lobby.join("b", "Bob");

  expect(lobby.isHost("a")).toBe(true);
  expect(lobby.isHost("b")).toBe(false);
  expect(lobby.host!.name).toBe("Alice");
});

// ----- join --------------------------------------------------------

test("joining twice with the same id is rejected", () => {
  const lobby = new Lobby();
  lobby.join("a", "Alice");
  expect(grab(() => lobby.join("a", "Alice again")).code).toBe("AlreadyJoined");
  expect(lobby.size).toBe(1);
});

test("two members may share a display name", () => {
  const lobby = new Lobby();
  lobby.join("a", "Sam");
  lobby.join("b", "Sam");
  expect(lobby.size).toBe(2);
});

test("joining past the cap is rejected as full", () => {
  const lobby = lobbyWith(Lobby.MAX_PLAYERS);
  const err = grab(() => lobby.join("extra", "Extra"));
  expect(err.code).toBe("LobbyFull");
  expect(err.message).toBe("the lobby is full at 12 players");
  expect(lobby.size).toBe(Lobby.MAX_PLAYERS);
});

// ----- leave -----------------------------------------------------

test("leaving removes the member", () => {
  const lobby = lobbyWith(3);
  lobby.leave("u1");
  expect(lobby.size).toBe(2);
  expect(lobby.contains("u1")).toBe(false);
});

test("leaving when not a member is rejected", () => {
  const lobby = lobbyWith(3);
  expect(grab(() => lobby.leave("ghost")).code).toBe("NotInLobby");
});

test("the host leaving promotes the next longest-waiting member", () => {
  const lobby = lobbyWith(3);
  expect(lobby.isHost("u0")).toBe(true);
  lobby.leave("u0");
  expect(lobby.isHost("u1")).toBe(true);
});

test("a non-host leaving does not change the host", () => {
  const lobby = lobbyWith(3);
  lobby.leave("u2");
  expect(lobby.isHost("u0")).toBe(true);
});

test("the last member leaving empties the lobby", () => {
  const lobby = lobbyWith(1);
  lobby.leave("u0");
  expect(lobby.isEmpty).toBe(true);
  expect(lobby.host).toBeNull();
});

test("seats shift for members behind a departure", () => {
  const lobby = lobbyWith(4);
  expect(lobby.seatOf("u3")).toBe(3);
  lobby.leave("u1");
  expect(lobby.seatOf("u0")).toBe(0);
  expect(lobby.seatOf("u2")).toBe(1);
  expect(lobby.seatOf("u3")).toBe(2);
});

// ----- start ----------------------------------------------------

test("canStart is false below the minimum and true at it", () => {
  const lobby = lobbyWith(4);
  expect(lobby.canStart).toBe(false);
  lobby.join("u4", "u4");
  expect(lobby.canStart).toBe(true);
});

test("only the host may start the game", () => {
  const lobby = lobbyWith(5);
  expect(grab(() => lobby.start("u1")).code).toBe("NotHost");
  expect(lobby.game).toBeNull();
});

test("starting below the minimum is rejected", () => {
  const lobby = lobbyWith(4);
  const err = grab(() => lobby.start("u0"));
  expect(err.code).toBe("TooFewPlayers");
  expect(err.message).toBe("need at least 5 players, got 4");
});

test("a successful start hands over a fresh engine", () => {
  const lobby = lobbyWith(7);
  const game = lobby.startWithSeed("u0", 1n);
  expect(game.state().players.length).toBe(7);
  expect(game.state().phase).toBe("Day");
  expect(game.state().round).toBe(1);

  expect(lobby.state).toBe("InGame");
  expect(lobby.game).not.toBeNull();
});

test("starting a second time is rejected while a game runs", () => {
  const lobby = lobbyWith(5);
  lobby.startWithSeed("u0", 1n);
  expect(grab(() => lobby.start("u0")).code).toBe("GameInProgress");
});

// ----- id-to-seat mapping -------------------------------------------

test("seatOf follows join order and memberAt is its inverse", () => {
  const lobby = lobbyWith(9);
  for (let i = 0; i < 9; i++) {
    const id = `u${i}`;
    const seat = lobby.seatOf(id);
    expect(seat).toBe(i);
    expect(lobby.memberAt(seat!)!.user).toBe(id);
  }
  expect(lobby.seatOf("nobody")).toBeNull();
  expect(lobby.memberAt(9)).toBeNull();
});

// ----- in-game lockout ---------------------------------------------

test("joining and leaving are locked out while a game runs", () => {
  const lobby = lobbyWith(5);
  lobby.startWithSeed("u0", 1n);
  expect(grab(() => lobby.join("late", "Late")).code).toBe("GameInProgress");
  expect(grab(() => lobby.leave("u1")).code).toBe("GameInProgress");
});

// ----- endGame ---------------------------------------------------

test("endGame needs a running game", () => {
  const lobby = lobbyWith(5);
  expect(grab(() => lobby.endGame()).code).toBe("NoGame");
});

test("endGame is rejected while the game is still going", () => {
  const lobby = lobbyWith(5);
  lobby.startWithSeed("u0", 1n);
  expect(grab(() => lobby.endGame()).code).toBe("GameNotOver");
});

test("endGame returns a finished lobby to waiting and it can restart", () => {
  const lobby = lobbyWith(6);
  lobby.startWithSeed("u0", 7n);
  playOut(lobby.game!);

  lobby.endGame();
  expect(lobby.state).toBe("Waiting");
  expect(lobby.size).toBe(6);
  expect(() => lobby.startWithSeed("u0", 8n)).not.toThrow();
});

// ----- integration: the mapping holds through a whole game ----------

test("the lobby maps every seat to the right member through a whole game", () => {
  for (let n = Lobby.MIN_PLAYERS; n <= 12; n++) {
    for (let seed = 0; seed < 25; seed++) {
      const lobby = lobbyWith(n);
      lobby.startWithSeed("u0", BigInt(seed));
      assertMappingIsConsistent(lobby, n);

      playOut(lobby.game!);
      expect(lobby.game!.state().isOver).toBe(true);
      // The roster is frozen during a game, so the mapping is unchanged.
      assertMappingIsConsistent(lobby, n);

      lobby.endGame();
      expect(() => lobby.startWithSeed("u0", BigInt(seed + 1))).not.toThrow();
    }
  }
});
