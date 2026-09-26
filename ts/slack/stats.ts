import type { ChannelStats, PlayerStats, TeamStats } from "../db/index.js";

const rate = (wins: number, played: number) => (played ? `${((wins / played) * 100).toFixed(1)}%` : "N/A");
const record = (stats: TeamStats) =>
  `${stats.played} played · ${stats.wins} wins · ${stats.losses} losses · ${rate(stats.wins, stats.played)} win rate`;

export function personalStats(channel: string, stats: PlayerStats): string {
  return [
    `*Your lifetime stats in <#${channel}>*`,
    `Overall: ${record(stats)}`,
    `Village team: ${record(stats.village)}`,
    `Werewolf team: ${record(stats.wolves)}`,
    ...(stats.played === 0 ? ["You haven't completed any games yet."] : []),
    "Completed games only; dev games excluded. Doctor, Seer, and Hunter count as village team. Team wins count even if you were eliminated.",
  ].join("\n");
}

export function channelStats(channel: string, stats: ChannelStats): string {
  return [
    `*Lifetime stats in <#${channel}>*`,
    `${stats.played} completed games`,
    `Village team: ${stats.villageWins} wins · ${rate(stats.villageWins, stats.played)} win rate`,
    `Werewolf team: ${stats.wolfWins} wins · ${rate(stats.wolfWins, stats.played)} win rate`,
    "*Top 3 players by times assigned Werewolf*",
    ...stats.topWolves.map((player, index) => `${index + 1}. <@${player.userId}> — ${player.count} times`),
    ...(stats.played === 0 ? ["No completed games yet."] : []),
    "Completed games only; dev games and bots excluded. Ties are ordered by Slack user ID.",
  ].join("\n");
}
