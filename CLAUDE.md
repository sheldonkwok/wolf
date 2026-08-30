# Wolf

## Goal
We are creating a werewolf game to play with friends on chat apps like Slack or Discord.
The rules can be found in @rules.md

## Stack
Rust
Bun TypeScript
napi-rs


## Components
### Game Engine - Rust
The game engine needs to be highly testable and inspectable. 
It's instantiated by passing in the number of players (minimum 5).
It should be able to report the state of game status.
There are functions that can be called on the instance to move state forward.
It needs to handle incorrect commands like invalid players targeted or commands that have already been played.
The engine is functionally the moderator from the rules.

### Lobby - Rust (eventually TypeScript)
A lobby is a group of players.
It provides a place for players to wait before the game starts.
The first person who joins the lobby is the host by default.
The host can decide when to start the game, which creates a new instance of the game engine.

### CLI - Bun TypeScript
The interactive test CLI (`ts/cli.ts`) is the front layer: arg parsing, prompting, rendering, and the bot opponents.
It drives the engine through the napi addon, not a second copy of the game logic.

## Layout
Cargo workspace: `crates/wolf` is the dependency-free engine + lobby; `crates/wolf-napi` is the only crate that links napi.
`ts/` holds the Bun front layer; `ts/native/` is the generated addon (gitignored).

## Build & Test
`bun install` once, then `bun run build:dev` to compile the addon into `ts/native/`.
`cargo test` covers the engine and lobby; `bun test` covers the binding and bots.
Play a game with `bun run cli -- --seed 42 --players 7 --reveal`.

## Style
Comments can be maximum one line
