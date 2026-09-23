# Wolf on Slack

Wolf runs one game in the public `#werewolf` or `#werewolf-test` channel selected by `SLACK_CHANNEL_ID`. Each instance only handles commands in its configured channel. It uses the existing lobby and Rust engine through napi, with Werewolves, Villagers, a Doctor, and a Seer.

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

Restart `bun run slackbot`, then send `@werewolf status` in your configured game channel, selecting the actual bot from Slack's mention picker. Startup prints the connected bot identity and channel ID. The terminal prints `Slack app_mention received.` for incoming mentions, an explanation for ignored mentions, and `Slack reply sent (channel).` after a successful status reply. These logs omit message contents and tokens. If no incoming mention appears, check the event subscription, that both tokens belong to the same app, and that only one bot process is running.

## Bun Socket Mode compatibility

Bun's built-in `undici` shim lacks the WebSocket `ping` export and heartbeat diagnostics used by Slack Socket Mode 3 ([upstream issue](https://github.com/oven-sh/bun/issues/37110)). This causes `Failed to send ping to Slack` errors and repeated reconnects.

The repository declares `undici` directly and uses `patchedDependencies` to redirect Socket Mode 3.0.1's two runtime imports to `undici/index.js`, loading the installed package. `bun install` applies the patch automatically. After updating, run `bun install` and restart `bun run slackbot`. When upgrading Socket Mode, review the patch and run `bun test ts/slack-socket.test.ts` to check real heartbeat and message exchange against a local WebSocket server.

## If night seems stuck

Night ends automatically after every living Werewolf, Doctor, and Seer submits an action. Eliminated players and Villagers do not need to act. With one surviving Werewolf, a Doctor, and a Seer, all three must choose before dawn, even if one is the attack target.

DM `status` to the bot to check your own action. It confirms whether your action is recorded or still needed, and resends buttons when you need to choose. Use the current night's buttons; older prompts expire. The channel's `@werewolf status` keeps individual night progress private. If the bot does not respond, check its terminal for delivery or connection errors. Keep the process running to preserve the active game.

## Play

For solo testing, run `bun run slackbot -- --dev`, then use `@werewolf join` and `@werewolf start`. Dev mode fills the game to five players with named bots. Bots take night actions and elimination votes automatically; bot wolves follow a human wolf's night target. Vote in the channel with `@werewolf vote @player`, or use a bot’s player number, such as `@werewolf vote 3`. Bots respond to human votes and can change their votes until a majority agrees. If a vote is split, submit another vote to continue. If all humans are eliminated, bots finish the game automatically. Bots receive no Slack DMs. After the game, the lobby is emptied; use `@werewolf join` and `@werewolf start` to play again with fresh bots. Without `--dev`, the normal player minimum and mention syntax apply.

- In your configured `#werewolf` or `#werewolf-test` channel, mention the bot: `@werewolf join`. The first player is host; 5–12 players can join.
- `@werewolf leave` leaves a waiting lobby; if the host leaves, the next player becomes host.
- The host uses `@werewolf start`. Everyone receives their role privately. Wolves also learn their pack. Games begin with Day 1 discussion and everyone alive; voting is available immediately. Play proceeds Day 1 → Night 1 → Day 2.
- At night, wolves choose a numbered player in their DM. The prompt maps each number to a Slack mention. Wolves can change a choice until all have chosen. If they disagree, all choose again using new buttons.
- During the day, any living player votes publicly with `@werewolf vote @player`, mentioning exactly one living player in the game. The bot announces the vote and progress toward a majority. There is no readiness step or DM elimination ballot.
- Each living player has one vote and can change it by repeating the command with a new target. When more than half of the living players vote for the same target, that player is eliminated immediately and night begins unless a team has won. A split vote keeps the day open, even if everyone has voted. Votes reset each day.
- When night resolves, the channel receives the outcome and the next day’s voting prompt. The host has no special control over voting, and there is no automatic timer.
- `@werewolf status` displays the public roster, phase, current day votes, and majority required. DM `status` to recover your role and any outstanding choice buttons. `@werewolf help` shows commands privately.
- After a win, the channel gets the final roles and a new empty lobby opens. Use `@werewolf join` to play again; the first player to join becomes the new host and can use `@werewolf start` once enough players have joined.

Game commands from other channels are ignored. Night choices, pack membership, and pending actor identities stay private. Stale buttons, duplicate event deliveries, outsiders, eliminated players, and duplicate votes cannot advance the game incorrectly. Target legality and outcomes are decided by the Rust engine, including its allowance for self-targets.

## Operation and checks

Run one bot process per workspace. Lobby state, game state, event deduplication, and the outgoing message queue live in memory; restarting loses them and players must rejoin. There is no automatic timeout or forced action for absent players, so living players should stay available for voting and night actions. Messages are sent in order; failed deliveries are retained and retried every five seconds. A persistent delivery failure pauses outgoing messages until Slack access is restored. An ambiguous network failure can produce a duplicate message, but retrying delivery does not replay a game command.

Tests use a fake Slack transport and the real addon, without workspace credentials or posting messages:

```sh
bun run build:dev
cargo test
bun test
bun run typecheck
```
