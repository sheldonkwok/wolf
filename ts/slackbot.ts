import { App, type BlockAction, type ButtonAction, type StaticSelectAction } from "@slack/bolt";
import manifest from "../slack/manifest.json";
import { openStats } from "./db/index.js";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackMessage } from "./slack/game.js";
import { registerHome } from "./slack/home.js";

export function slackArgs(argv: string[]) {
  const args = { dev: false, help: false };
  for (const arg of argv) {
    if (arg === "--dev") args.dev = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg !== "--") throw new Error(`Unknown argument: ${arg}. Use --help for usage.`);
  }
  return args;
}

export function slackErrorMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ("data" in current && current.data && typeof current.data === "object") {
      const data = current.data as Record<string, unknown>;
      if (data.error === "messages_tab_disabled") {
        return "Slack messages_tab_disabled: the app's Messages tab is disabled, blocking private game messages.\nIn the Slack app settings → App Home → Show Tabs, enable Messages Tab and allow users to send messages from that tab. Save changes. The repository manifest already enables these settings; apply them to the app used by SLACK_BOT_TOKEN. Keep this bot process running: queued messages retry every second after the setting is fixed.\nSee slack/README.md.";
      }
      if (data.error === "missing_scope") {
        const scopes = (value: unknown) =>
          typeof value === "string"
            ? value
                .split(",")
                .filter((scope) => /^[a-z_]+(?::[a-z_:]+)?$/.test(scope))
                .join(", ")
            : "";
        const needed = scopes(data.needed);
        const provided = scopes(data.provided);
        const fix = needed.includes("connections:write")
          ? "Add connections:write to the app-level token under Basic Information → App-Level Tokens, and update SLACK_APP_TOKEN if the token changes."
          : `Under OAuth & Permissions → Bot Token Scopes, grant ${manifest.oauth_config.scopes.bot.join(", ")}. Reinstall the app to the workspace, then ensure SLACK_BOT_TOKEN matches the installed Bot User OAuth Token. Use a public #werewolf or #werewolf-test channel.`;
        return `Slack missing_scope.${needed ? ` API scope requirements: ${needed} (depending on conversation type).` : ""}${provided ? ` Token currently grants: ${provided}.` : ""}\n${fix}\nSee slack/README.md.`;
      }
    }
    current = "original" in current ? current.original : undefined;
  }
  return error instanceof Error ? error.message : "Slack request failed.";
}

export function slackConfig(env: Record<string, string | undefined>) {
  const required = (name: string, pattern: RegExp): string => {
    const value = env[name]?.trim();
    if (!value || !pattern.test(value))
      throw new Error(`Set ${name} in .env (see .env.example and slack/README.md).`);
    return value;
  };
  return {
    token: required("SLACK_BOT_TOKEN", /^xoxb-/),
    appToken: required("SLACK_APP_TOKEN", /^xapp-/),
    channel: required("SLACK_CHANNEL_ID", /^C[A-Z0-9]+$/),
  };
}

export function slackChannel(channel?: {
  name?: string;
  is_member?: boolean;
  is_archived?: boolean;
}): string {
  if (
    !channel?.name ||
    !["werewolf", "werewolf-test"].includes(channel.name) ||
    !channel.is_member ||
    channel.is_archived
  ) {
    throw new Error(
      "SLACK_CHANNEL_ID must identify #werewolf or #werewolf-test; invite the bot there and ensure the channel is not archived.",
    );
  }
  return channel.name;
}

export function choiceNameResolver(client: App["client"]) {
  const names = new Map<string, string>();
  return async (message: SlackMessage): Promise<SlackMessage> => {
    if (!message.choices) return message;
    const choices = [];
    for (const choice of message.choices) {
      if (!choice.slackUser) {
        choices.push(choice);
        continue;
      }
      const id = choice.slackUser;
      let name = names.get(id);
      if (!name) {
        const result = await client.users.info({ user: id });
        if (!result.ok) throw new Error(result.error ?? "Slack user lookup failed.");
        const user = result.user;
        name =
          [user?.profile?.real_name, user?.real_name, user?.profile?.display_name, user?.name]
            .map((value) => value?.trim())
            .find((value) => value) ?? id;
        names.set(id, name);
      }
      choices.push({ ...choice, label: name });
    }
    return { ...message, choices };
  };
}

export function messageBlocks(message: SlackMessage) {
  if (!message.choices) return undefined;
  return [
    { type: "section", text: { type: "mrkdwn", text: message.text } },
    ...Array.from({ length: Math.ceil(message.choices.length / 100) }, (_, index) => ({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: `wolf_choice_${index}`,
          placeholder: { type: "plain_text", text: "Choose a player" },
          options: message.choices!.slice(index * 100, index * 100 + 100).map((choice) => ({
            text: { type: "plain_text", text: Array.from(choice.label).slice(0, 75).join(""), emoji: false },
            value: choice.value,
          })),
        },
      ],
    })),
  ];
}

async function main(): Promise<void> {
  const args = slackArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: bun run slackbot [--dev]\n\n--dev  Fill games to five players with bots; vote in the channel by mention or bot player number.\n--help Show this help.",
    );
    return;
  }
  const config = slackConfig(process.env);
  const app = new App({ token: config.token, appToken: config.appToken, socketMode: true });
  const [auth, conversation] = await Promise.all([
    app.client.auth.test(),
    app.client.conversations.info({ channel: config.channel }).catch((error) => {
      throw new Error(`Checking configured game channel (conversations.info): ${slackErrorMessage(error)}`);
    }),
  ]);
  if (!auth.user_id || !auth.team_id) throw new Error("Slack did not identify the bot or workspace.");
  const channelName = slackChannel(conversation.channel);
  const stats = openStats();
  registerHome(app, auth.team_id, config.channel, auth.user_id);

  const dms = new Map<string, string>();
  const resolveChoiceNames = choiceNameResolver(app.client);
  const delivery = new SlackDelivery(
    new SlackGame(config.channel, undefined, {
      ...args,
      recordResult: (result) => stats.record(auth.team_id!, result),
      playerStats: (user) => stats.personal(auth.team_id!, config.channel, user),
      channelStats: () => stats.channel(auth.team_id!, config.channel),
    }),
    async (message) => {
      let channel = config.channel;
      if (message.destination === "dm") {
        const user = message.user!;
        let dm = dms.get(user);
        if (!dm) {
          dm = (await app.client.conversations.open({ users: user })).channel?.id;
          if (!dm) throw new Error("Slack did not return a DM channel.");
          dms.set(user, dm);
        }
        channel = dm;
      }
      const payload = {
        channel,
        text: message.text,
        blocks: messageBlocks(await resolveChoiceNames(message)),
        unfurl_links: false,
        unfurl_media: false,
      };
      if (message.destination === "ephemeral") {
        await app.client.chat.postEphemeral({ ...payload, user: message.user! });
      } else {
        await app.client.chat.postMessage(payload);
      }
      console.log(`Slack reply sent (${message.destination}).`);
    },
    (error) =>
      console.error(`Slack delivery failed; queued messages will retry. ${slackErrorMessage(error)}`),
  );

  app.event("app_mention", async ({ event, body }) => {
    console.log("Slack app_mention received.");
    if (body.team_id !== auth.team_id) {
      console.log("Slack mention ignored: workspace does not match SLACK_BOT_TOKEN.");
      return;
    }
    if (event.bot_id || !event.user || event.user === auth.user_id) {
      console.log("Slack mention ignored: sender is a bot or has no user ID.");
      return;
    }
    if (event.channel !== config.channel) {
      console.log("Slack mention ignored: channel does not match SLACK_CHANNEL_ID.");
      return;
    }
    const mention = `<@${auth.user_id}>`;
    const text = event.text.trim();
    if (!text.startsWith(mention)) {
      console.log("Slack mention ignored: the message must start with a mention of this bot.");
      return;
    }
    await delivery.receive({
      id: body.event_id,
      kind: "mention",
      user: event.user,
      channel: event.channel,
      text: text.slice(mention.length),
    });
  });

  app.event("message", async ({ event, body }) => {
    if (
      body.team_id !== auth.team_id ||
      event.subtype ||
      !("user" in event) ||
      !event.user ||
      event.user === auth.user_id ||
      event.channel_type !== "im"
    )
      return;
    await delivery.receive({
      id: body.event_id,
      kind: "dm",
      user: event.user,
      channel: event.channel,
      text: event.text ?? "",
    });
  });

  app.action<BlockAction<StaticSelectAction | ButtonAction>>(
    /^wolf_choice_\d+$/,
    async ({ ack, body, action }) => {
      await ack();
      const value = action.type === "static_select" ? action.selected_option?.value : action.value;
      if (body.team?.id !== auth.team_id || !body.channel?.id.startsWith("D") || !value) return;
      await delivery.receive({
        id: `action:${body.user.id}:${action.action_ts}:${action.action_id}`,
        kind: "choice",
        user: body.user.id,
        channel: body.channel.id,
        value,
      });
    },
  );

  app.error(async (error) => console.error(`Slack event handling failed. ${slackErrorMessage(error)}`));
  try {
    await app.start();
  } catch (error) {
    stats.close();
    throw error;
  }
  const retry = setInterval(() => void delivery.retry(), 1_000);
  const stop = async () => {
    clearInterval(retry);
    await app.stop();
    await delivery.retry();
    stats.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(
    `Wolf is connected to #${channelName} (${config.channel}) as ${auth.user ?? "Wolf"} (${auth.user_id}). Mention the bot with help to begin.`,
  );
  if (args.dev)
    console.log("Dev mode enabled: games fill to five players with bots. Join and start to play solo.");
  console.log(
    "Waiting for app_mention events. If mentions produce no log, check Event Subscriptions → Enable Events and Subscribe to bot events → app_mention in the Slack app settings.",
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(slackErrorMessage(error));
    process.exitCode = 1;
  });
}
