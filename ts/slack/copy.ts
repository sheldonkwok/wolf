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

// The 12-player structured rules: roster, sheriff election, the Fool, and Night 1 last words.
export function structuredRules(): string {
  return `With exactly 12 players, the game uses Chinese structured rules: 4 Werewolves, 4 Villagers, a Seer, a Witch, a Hunter, and a Fool. It opens with a sheriff election before Day 1: every living player votes with ${SHERIFF_COMMAND}, and an early majority or the unique leader once everyone has voted becomes sheriff; a tie means no sheriff. The sheriff's day vote counts as 1.5 votes; the badge is lost when the sheriff dies. Players eliminated on Night 1 may share last words once with ${LAST_WORDS_COMMAND} before Day 2 ends.`;
}
