import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackMessage } from "./slack/game.js";
import manifest from "../slack/manifest.json";

export function slackErrorMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ("data" in current && current.data && typeof current.data === "object") {
      const data = current.data as Record<string, unknown>;
      if (data.error === "missing_scope") {
        const scopes = (value: unknown) => typeof value === "string"
          ? value.split(",").filter(scope => /^[a-z_]+(?::[a-z_:]+)?$/.test(scope)).join(", ")
          : "";
        const needed = scopes(data.needed);
        const provided = scopes(data.provided);
        const fix = needed.includes("connections:write")
          ? "Add connections:write to the app-level token under Basic Information → App-Level Tokens, and update SLACK_APP_TOKEN if the token changes."
          : `Under OAuth & Permissions → Bot Token Scopes, grant ${manifest.oauth_config.scopes.bot.join(", ")}. Reinstall the app to the workspace, then ensure SLACK_BOT_TOKEN matches the installed Bot User OAuth Token. Use a public #werewolf channel.`;
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
    if (!value || !pattern.test(value)) throw new Error(`Set ${name} in .env (see .env.example and slack/README.md).`);
    return value;
  };
  return {
    token: required("SLACK_BOT_TOKEN", /^xoxb-/),
    appToken: required("SLACK_APP_TOKEN", /^xapp-/),
    channel: required("SLACK_CHANNEL_ID", /^C[A-Z0-9]+$/),
  };
}

export function messageBlocks(message: SlackMessage) {
  if (!message.choices) return undefined;
  return [
    { type: "section", text: { type: "mrkdwn", text: message.text } },
    ...Array.from({ length: Math.ceil(message.choices.length / 5) }, (_, index) => ({
      type: "actions",
      elements: message.choices!.slice(index * 5, index * 5 + 5).map((choice, offset) => ({
        type: "button",
        action_id: `wolf_choice_${index * 5 + offset}`,
        text: { type: "plain_text", text: choice.label },
        value: choice.value,
      })),
    })),
  ];
}

async function main(): Promise<void> {
  const config = slackConfig(process.env);
  const app = new App({ token: config.token, appToken: config.appToken, socketMode: true });
  const [auth, conversation] = await Promise.all([
    app.client.auth.test(),
    app.client.conversations.info({ channel: config.channel }).catch(error => {
      throw new Error(`Checking #werewolf (conversations.info): ${slackErrorMessage(error)}`);
    }),
  ]);
  if (!auth.user_id || !auth.team_id) throw new Error("Slack did not identify the bot or workspace.");
  if (conversation.channel?.name !== "werewolf" || !conversation.channel.is_member || conversation.channel.is_archived) {
    throw new Error("SLACK_CHANNEL_ID must identify #werewolf; invite the bot there and ensure the channel is not archived.");
  }

  const dms = new Map<string, string>();
  const delivery = new SlackDelivery(new SlackGame(config.channel), async message => {
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
    const payload = { channel, text: message.text, blocks: messageBlocks(message), unfurl_links: false, unfurl_media: false };
    if (message.destination === "ephemeral") {
      await app.client.chat.postEphemeral({ ...payload, user: message.user! });
    } else {
      await app.client.chat.postMessage(payload);
    }
    console.log(`Slack reply sent (${message.destination}).`);
  }, error => console.error(`Slack delivery failed; queued messages will retry. ${slackErrorMessage(error)}`));

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
    await delivery.receive({ id: body.event_id, kind: "mention", user: event.user, channel: event.channel, text: text.slice(mention.length) });
  });

  app.event("message", async ({ event, body }) => {
    if (body.team_id !== auth.team_id || event.subtype || !("user" in event) || !event.user || event.user === auth.user_id || event.channel_type !== "im") return;
    await delivery.receive({ id: body.event_id, kind: "dm", user: event.user, channel: event.channel, text: event.text ?? "" });
  });

  app.action<BlockAction<ButtonAction>>(/^wolf_choice_\d+$/, async ({ ack, body, action }) => {
    await ack();
    if (body.team?.id !== auth.team_id || !body.channel?.id.startsWith("D") || !action.value) return;
    await delivery.receive({
      id: `action:${body.user.id}:${action.action_ts}:${action.action_id}`,
      kind: "choice", user: body.user.id, channel: body.channel.id, value: action.value,
    });
  });

  app.error(async error => console.error(`Slack event handling failed. ${slackErrorMessage(error)}`));
  await app.start();
  const retry = setInterval(() => void delivery.retry(), 5_000);
  const stop = async () => {
    clearInterval(retry);
    await app.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(`Wolf is connected to #werewolf (${config.channel}) as ${auth.user ?? "Wolf"} (${auth.user_id}). Mention the bot with help to begin.`);
  console.log("Waiting for app_mention events. If mentions produce no log, check Event Subscriptions → Enable Events and Subscribe to bot events → app_mention in the Slack app settings.");
}

if (import.meta.main) {
  main().catch(error => {
    console.error(slackErrorMessage(error));
    process.exitCode = 1;
  });
}
