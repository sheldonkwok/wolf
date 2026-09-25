import type { App } from "@slack/bolt";

export function registerHome(app: App, team: string, channel: string, bot: string): void {
  app.event("app_home_opened", async ({ event, body, client }) => {
    if (body.team_id !== team || event.tab !== "home") return;
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Welcome to Werewolf" } },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Play with friends in <#${channel}>. Find the werewolves before they take over the village!`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Get started*\nIn <#${channel}>, mention <@${bot}> with \`join\` to enter the lobby. The first player is the host and can use \`start\` once 5–12 players have joined.\nMention the bot with \`status\` to see the game or \`help\` for all commands.`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*During a game*\nIf a Seer is present, the opening gives them one private inspection before Day 1. Everyone else waits: no attacks, protection, or voting. Without a Seer, Day 1 starts immediately. Discuss and vote in the game channel during the day. Your role, opening and night-action buttons, and the Hunter's final-shot buttons arrive privately in the *Messages* tab. DM `status` to recover your role, private inspection history, and current prompt.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Roles*\n• *Villager* — Find the Werewolves through discussion and daytime votes. No night action.\n• *Werewolf* — Know your pack and agree on one player to eliminate each night. Blend in during the day.\n• *Doctor* — Protect one player each night, including yourself. If the pack attacks that player, they survive.\n• *Seer* — Inspect one living player before Day 1 and each night to privately learn whether they are a Werewolf, not their exact innocent role.\n• *Hunter* — On the village team, with no night action. When eliminated by a vote or the Werewolves, choose one living player to take down using DM buttons. A saved Hunter does not shoot, and the Doctor cannot protect against the shot. Play and victory checks wait for your shot.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Role selection*\nWerewolves fill one third of the seats, rounded down (at least one). Among the remaining players, up to the greater of two or 33% (rounded down) receive distinct special roles randomly chosen from Doctor, Seer, and Hunter. Remaining seats are ordinary Villagers; not every game includes every special role.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Winning*\nVillagers, the Doctor, the Seer, and the Hunter win together when all Werewolves are eliminated. Werewolves win when they equal or outnumber all other living players. The bot moderates; the host is a player, not a separate role.",
            },
          },
        ],
      },
    });
  });
}
