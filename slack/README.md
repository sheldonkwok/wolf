# Wolf on Slack

Wolf runs one game in the public `#werewolf` channel. It uses the existing lobby and Rust engine through napi. The engine currently supports Werewolves and Villagers only; Doctor and Seer are not implemented.

## Setup

1. Create an app at [Slack's app dashboard](https://api.slack.com/apps) using **From a manifest**, select your workspace, and paste [manifest.json](manifest.json).
2. Install the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**.
3. Under **Basic Information → App-Level Tokens**, generate a token with `connections:write` (`xapp-…`). Socket Mode is enabled by the manifest, so no public HTTP endpoint or signing secret is needed.
4. Create a public `#werewolf` channel and invite Wolf. Copy its channel ID from the channel details. Startup verifies both its name and the bot's membership.
5. Copy `.env.example` to `.env` at the repository root and fill in the tokens and channel ID. Bun loads this file automatically; it is gitignored.
6. Run:

   ```sh
   bun install
   bun run build:dev
   bun run slackbot
   ```

Slack reference: [Bolt setup and Socket Mode](https://docs.slack.dev/tools/bolt-js/creating-an-app/). The manifest requests mentions, public channel metadata, message sending, and direct message access; it does not read general channel conversations.

## Fixing `missing_scope`

An installed token can have older permissions than the saved app manifest. Under **OAuth & Permissions → Bot Token Scopes**, ensure all five scopes from the manifest are present: `app_mentions:read`, `channels:read`, `chat:write`, `im:history`, and `im:write`. Then **Reinstall to Workspace** and ensure `.env` uses that app's installed Bot User OAuth Token. Restart with `bun run slackbot`. [Slack requires reinstalling when scopes change](https://docs.slack.dev/tools/bolt-js/creating-an-app/#subscribing-to-events).

Startup uses `conversations.info` to check the public `#werewolf` channel, which needs `channels:read`. Slack may list scopes for multiple conversation types in the error; you do not need to grant all of them for a public channel. If the error instead names `connections:write`, add that scope to the app-level token under **Basic Information → App-Level Tokens** and update `SLACK_APP_TOKEN` if it changes. This scope belongs to the `xapp-…` token, not the bot token.

When reusing an existing Slack app, also apply the manifest's event subscriptions (`app_mention`, `message.im`), Socket Mode, interactivity, and App Home messages settings.

## Play

- In `#werewolf`, mention the bot: `@Wolf join`. The first player is host; 5–12 players can join.
- `@Wolf leave` leaves a waiting lobby; if the host leaves, the next player becomes host.
- The host uses `@Wolf start`. Everyone receives their role privately. Wolves also learn their pack.
- At night, wolves choose a numbered player in their DM. The prompt maps each number to a Slack mention. Wolves can change a choice until all have chosen. If they disagree, all choose again using new buttons.
- When night resolves, the channel receives the eliminated player's role and a discussion prompt. After 3–5 minutes, the host uses `@Wolf vote` to open private voting for every living player. There is no automatic timer.
- Each day vote is final. When all living players have voted, the engine resolves the result. A tie eliminates nobody; play continues until a team wins.
- `@Wolf status` displays the public roster and phase. DM `status` to recover your role and any outstanding choice buttons. `@Wolf help` shows commands privately.
- After a win, the channel gets the final roles and the roster returns to the waiting lobby. Players may join or leave, and the host can start again.

Game commands from other channels are ignored. Night choices, pack membership, and pending actor identities stay private. Stale buttons, duplicate event deliveries, outsiders, eliminated players, and duplicate votes cannot advance the game incorrectly. Target legality and outcomes are decided by the Rust engine, including its allowance for self-targets.

## Operation and checks

Run one bot process per workspace. Lobby state, game state, event deduplication, and the outgoing message queue live in memory; restarting loses them and players must rejoin. There is no automatic timeout or forced action for absent players, so the host should stay available even after elimination. Messages are sent in order; failed deliveries are retained and retried every five seconds. A persistent delivery failure pauses outgoing messages until Slack access is restored. An ambiguous network failure can produce a duplicate message, but retrying delivery does not replay a game command.

Tests use a fake Slack transport and the real addon, without workspace credentials or posting messages:

```sh
bun run build:dev
cargo test
bun test
tsc --noEmit
```
