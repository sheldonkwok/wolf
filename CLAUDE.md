# Wolf

## Goal
We are creating a werewolf game to play with friends on chat apps like Slack or Discord.
The rules can be found in @rules.md

## Stack
Rust


## Components
### Game Engine
The game engine needs to be highly testable and inspectable. 
It's instantiated by passing in the number of players (minimum 5).
It should be able to report the state of game status.
There are functions that can be called on the instance to move state forward.
It needs to handle incorrect commands like invalid players targeted or commands that have already been played.
The engine is functionally the moderator from the rules.
