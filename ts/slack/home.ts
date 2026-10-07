import type { App } from "@slack/bolt";
import { Lobby } from "../lobby.js";
import { VOTE_COMMAND, votingRules } from "./copy.js";
import { roleSelection, rolesList, winningRules } from "./rules.js";

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
              text: `*Get started*\nIn <#${channel}>, mention <@${bot}> with \`join\` to enter the lobby. The first player is the host and can use \`start\` once ${Lobby.MIN_PLAYERS}–${Lobby.MAX_PLAYERS} players have joined.\nMention the bot with \`status\` to see the game or \`help\` for all commands.`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Lifetime stats*\nDM `stats` for your wins, losses, and games played by team. In the game channel, use `@werewolf stats` for village vs. Werewolf win rates and the top 3 players by times assigned Werewolf. Only completed games in this channel count; dev games and bots are excluded. Doctor, Seer, Hunter, and Witch count as village team, and team wins count even if you were eliminated.",
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
              text: `*Day voting*\nVote publicly with ${VOTE_COMMAND}. ${votingRules()} Votes reset each day.`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Roles*
${rolesList()}`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Role selection*
${roleSelection()}`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Winning*
${winningRules()} The bot moderates; the host is a player, not a separate role.`,
            },
          },
        ],
      },
    });
  });
}
