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
