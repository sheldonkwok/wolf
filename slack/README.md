# Wolf on Slack

Wolf runs one game in the public `#werewolf` or `#werewolf-test` channel selected by `SLACK_CHANNEL_ID`. Each instance only handles commands in its configured channel. It uses the existing lobby and Rust engine through napi. The engine currently supports Werewolves and Villagers only; Doctor and Seer are not implemented.

## Setup

1. Create an app at [Slack's app dashboard](https://api.slack.com/apps) using **From a manifest**, select your workspace, and paste [manifest.json](manifest.json).
2. Install the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**.
3. Under **Basic Information → App-Level Tokens**, generate a token with `connections:write` (`xapp-…`). Socket Mode is enabled by the manifest, so no public HTTP endpoint or signing secret is needed.
4. Create a public `#werewolf` or `#werewolf-test` channel and invite Wolf. Copy its channel ID from the channel details. Startup verifies both its name and the bot's membership.
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

Startup uses `conversations.info` to check the configured public game channel, which needs `channels:read`. Slack may list scopes for multiple conversation types in the error; you do not need to grant all of them for a public channel. If the error instead names `connections:write`, add that scope to the app-level token under **Basic Information → App-Level Tokens** and update `SLACK_APP_TOKEN` if it changes. This scope belongs to the `xapp-…` token, not the bot token.

When reusing an existing Slack app, also apply the manifest's event subscriptions (`app_mention`, `message.im`), Socket Mode, interactivity, and App Home messages settings.

## Fixing `messages_tab_disabled` after starting a game

Starting a game sends private roles and choice prompts. Slack rejects these DMs when the installed app's Messages tab is disabled, even if channel replies work. In [Slack's app dashboard](https://api.slack.com/apps), select the app used by `SLACK_BOT_TOKEN`, open **App Home → Show Tabs**, enable **Messages Tab**, and allow users to send messages from that tab. Save changes. See [Slack's Messages tab setup](https://docs.slack.dev/surfaces/app-home/#enable-messages-tab).

The repository manifest already sets `features.app_home.messages_tab_enabled` to `true` and `messages_tab_read_only_enabled` to `false`; changing the local file does not update an existing Slack app. Keep the bot process running while fixing the app settings: the queue retries every five seconds and resumes delivery once Slack accepts DMs. Restarting loses the current game and queued messages, requiring players to rejoin and start again.

## Connected but no response to mentions

In the Slack app settings, open **Event Subscriptions**, turn **Enable Events** on, and ensure **Subscribe to bot events** includes `app_mention` and `message.im`. Save changes and reinstall if Slack prompts you. Scopes such as `app_mentions:read` grant access; event subscriptions separately tell Slack which events to send. See [Slack's event setup instructions](https://docs.slack.dev/tools/bolt-js/creating-an-app/#subscribing-to-events).

Restart `bun run slackbot`, then send `@Wolf status` in your configured game channel, selecting the actual bot from Slack's mention picker. Startup prints the connected bot identity and channel ID. The terminal prints `Slack app_mention received.` for incoming mentions, an explanation for ignored mentions, and `Slack reply sent (channel).` after a successful status reply. These logs omit message contents and tokens. If no incoming mention appears, check the event subscription, that both tokens belong to the same app, and that only one bot process is running.

## Bun Socket Mode compatibility

Bun's built-in `undici` shim lacks the WebSocket `ping` export and heartbeat diagnostics used by Slack Socket Mode 3 ([upstream issue](https://github.com/oven-sh/bun/issues/37110)). This causes `Failed to send ping to Slack` errors and repeated reconnects.

The repository declares `undici` directly and uses `patchedDependencies` to redirect Socket Mode 3.0.1's two runtime imports to `undici/index.js`, loading the installed package. `bun install` applies the patch automatically. After updating, run `bun install` and restart `bun run slackbot`. When upgrading Socket Mode, review the patch and run `bun test ts/slack-socket.test.ts` to check real heartbeat and message exchange against a local WebSocket server.

## Play

For solo testing, run `bun run slackbot -- --dev`, then use `@Wolf join` and `@Wolf start`. Dev mode fills the game to five players with named bots. Bots take night actions and elimination votes automatically; bot wolves follow a human wolf's night target. Your `ready` or `vote` command supplies enough readiness to open elimination voting in a solo game, then you choose your elimination target in the DM. If all humans are eliminated, bots finish the game automatically. Bots receive no Slack DMs and leave the lobby after the game, so humans can join or leave before restarting. Without `--dev`, the normal player minimum and readiness rules apply.

- In your configured `#werewolf` or `#werewolf-test` channel, mention the bot: `@Wolf join`. The first player is host; 5–12 players can join.
- `@Wolf leave` leaves a waiting lobby; if the host leaves, the next player becomes host.
- The host uses `@Wolf start`. Everyone receives their role privately. Wolves also learn their pack.
- At night, wolves choose a numbered player in their DM. The prompt maps each number to a Slack mention. Wolves can change a choice until all have chosen. If they disagree, all choose again using new buttons.
- When night resolves, the channel receives the eliminated player's role and a discussion prompt. Any living player can use `@Wolf ready`, `@Wolf ready to vote`, or `@Wolf vote`, or DM `ready`, `ready to vote`, or `vote`. Once more than half of the living players are ready, private elimination voting opens for every living player. The host has no special control over voting, and there is no automatic timer.
- Readiness counts each living player once and resets each day. Status shows progress toward the required majority. Readiness opens voting; it does not cast an elimination vote or advance directly to night.
- Each day vote is final. When all living players have voted, the engine resolves the result. A tie eliminates nobody; play continues until a team wins.
- `@Wolf status` displays the public roster and phase. DM `status` to recover your role and any outstanding choice buttons. `@Wolf help` shows commands privately.
- After a win, the channel gets the final roles and the roster returns to the waiting lobby. Players may join or leave, and the host can start again.

Game commands from other channels are ignored. Night choices, pack membership, and pending actor identities stay private. Stale buttons, duplicate event deliveries, outsiders, eliminated players, and duplicate votes cannot advance the game incorrectly. Target legality and outcomes are decided by the Rust engine, including its allowance for self-targets.

## Operation and checks

Run one bot process per workspace. Lobby state, game state, event deduplication, and the outgoing message queue live in memory; restarting loses them and players must rejoin. There is no automatic timeout or forced action for absent players, so living players should stay available for readiness and voting. Messages are sent in order; failed deliveries are retained and retried every five seconds. A persistent delivery failure pauses outgoing messages until Slack access is restored. An ambiguous network failure can produce a duplicate message, but retrying delivery does not replay a game command.

Tests use a fake Slack transport and the real addon, without workspace credentials or posting messages:

```sh
bun run build:dev
cargo test
bun test
bun run typecheck
```
