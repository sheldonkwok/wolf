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
              text: "*Lifetime stats*\nDM `stats` for your wins, losses, and games played by team. In the game channel, use `@werewolf stats` for village vs. Werewolf win rates and the top 3 players by times assigned Werewolf. Only completed games in this channel count; dev games and bots are excluded. Doctor, Seer, and Hunter count as village team, and team wins count even if you were eliminated.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*During a game*\nEvery game starts on Day 1 as soon as roles are dealt. If present, the Seer may make one private inspection during Day 1, their only daytime inspection; if Day 1 ends before they choose, it is skipped. Public messages do not reveal whether a Seer exists or has acted. Discuss and vote in the game channel during the day. Your role, the Seer's Day 1 inspection and night-action dropdowns, and the Hunter's final-shot dropdowns arrive privately in the *Messages* tab. DM `status` to recover your role, private inspection history, and current prompt.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Day voting*\nVote publicly with `@werewolf vote @player`. A strict majority (more than half of living players) eliminates a player immediately. Otherwise, once every living player has voted, the player with the most votes is eliminated. A tie for the most votes eliminates nobody and night begins. You can change your vote until a majority is reached or everyone has voted. Votes reset each day.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Roles*\n• *Villager* — Find the Werewolves through discussion and daytime votes. No night action.\n• *Werewolf* — Know your pack and agree on one player to eliminate each night. Blend in during the day.\n• *Doctor* — Protect one player each night, including yourself. If the pack attacks that player, they survive.\n• *Seer* — Inspect one living player during Day 1 and each night to privately learn whether they are a Werewolf, not their exact innocent role. Day 1 is your only daytime inspection; missing it skips only that inspection, and your Night 1 action is unaffected.\n• *Hunter* — On the village team, with no night action. When eliminated by a vote or the Werewolves, choose one living player to take down using DM dropdowns. A saved Hunter does not shoot, and the Doctor cannot protect against the shot. Play and victory checks wait for your shot.",
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
