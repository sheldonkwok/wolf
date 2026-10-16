// Rule wording shared by channel messages, command help, and the Home tab; rules.md states the same rules.

export const VOTE_COMMAND = "`@werewolf vote @player`";

// The day-vote rules; pass the live threshold while a game is running.
export function votingRules(majority?: number): string {
  const threshold = majority === undefined ? "(more than half of living players)" : `of ${majority} votes`;
  return `A strict majority ${threshold} eliminates a player early. Otherwise, once all living players vote, the unique leader (plurality) is eliminated; a tie for the most votes eliminates nobody. Night then begins. Repeat the command to change your vote until a majority is reached or everyone has voted.`;
}

// The one-line reminder of the same rules that heads the vote leaderboard.
export function votingSummary(majority: number): string {
  return `${majority} for an early majority; all living players voted: unique plurality is eliminated, top tie eliminates nobody`;
}

export const SHERIFF_COMMAND = "`@werewolf sheriff @player`";

export const LAST_WORDS_COMMAND = "`@werewolf last words <message>`";

export const NOMINATE_COMMANDS = "`@werewolf run` or `@werewolf pass`";

// The 12-player structured rules: roster, night-first order, sheriff election and badge, the silenced Hunter, and Night 1 last words.
export function structuredRules(): string {
  return `With exactly 12 players, the game uses Chinese structured rules: 4 Werewolves, 4 Villagers, a Seer, a Witch, a Hunter, and a Fool. Play starts with Night 1. The next morning, before the night's deaths are announced, everyone declares with ${NOMINATE_COMMANDS}, including that night's victims. Non-candidates then elect a sheriff with ${SHERIFF_COMMAND}: a lone candidate wins unopposed; otherwise an early majority or the unique leader once everyone has voted wins, and a tie means no sheriff. Candidates cannot vote and may drop out with \`@werewolf withdraw\`. The sheriff's day vote counts as 1.5 votes; a dead sheriff passes the badge to a living player or tears it up. Night 1 victims may share last words once with ${LAST_WORDS_COMMAND} before Day 1 ends. A poisoned Hunter cannot shoot.`;
}
