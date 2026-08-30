// Presentation helpers: seat names and the phase banners / roster / report lines,
// kept byte-for-byte compatible with the old Rust CLI's output.

import type { GameState, Role } from "./engine.js";

// Friendly seat names; seats past the table fall back to `P{n}`.
export const NAMES = [
  "Alice", "Bob", "Cass", "Dev", "Eve", "Finn", "Gwen", "Hugo",
  "Iris", "Jack", "Kira", "Leo", "Mona", "Nia", "Otto", "Pip",
] as const;

export function nameOf(id: number): string {
  return NAMES[id] ?? `P${id}`;
}

// The Role string enum already reads "Villager" / "Werewolf".
export function roleTag(role: Role): string {
  return role;
}

export function banner(title: string, state: GameState, reveal: boolean): void {
  console.log(`\n── ${title} ${"─".repeat(30)}`);
  if (reveal) printRoster(state);
}

export function printRoster(state: GameState): void {
  for (const p of state.players) {
    const status = p.alive ? "" : "  (dead)";
    console.log(`  ${p.id} ${nameOf(p.id).padEnd(6)} ${roleTag(p.role)}${status}`);
  }
}
