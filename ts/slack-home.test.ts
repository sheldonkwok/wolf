import { expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import manifest from "../slack/manifest.json";
import { votingRules } from "./slack/copy.js";
import { registerHome } from "./slack/home.js";

test("Home is enabled and subscribed in the manifest", () => {
  expect(manifest.features.app_home.home_tab_enabled).toBe(true);
  expect(manifest.settings.event_subscriptions.bot_events).toContain("app_home_opened");
});

test("opening Home publishes instructions only for the configured workspace and Home tab", async () => {
  let listener: (args: unknown) => Promise<void> = async () => {
    throw new Error("Home listener was not registered");
  };
  const app = {
    event(name: string, handler: typeof listener) {
      expect(name).toBe("app_home_opened");
      listener = handler;
    },
  } as unknown as App;
  registerHome(app, "T1", "C1", "B1");
  const published: unknown[] = [];
  const open = (team: string, tab: string) =>
    listener({
      body: { team_id: team },
      event: { user: "U1", tab },
      client: { views: { publish: async (payload: unknown) => published.push(payload) } },
    });
  await open("T2", "home");
  await open("T1", "messages");
  expect(published).toHaveLength(0);
  await open("T1", "home");
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ user_id: "U1", view: { type: "home" } });
  expect(JSON.stringify(published[0])).toContain("<#C1>");
  expect(JSON.stringify(published[0])).toContain("<@B1>");
  const page = JSON.stringify(published[0]);
  for (const role of ["Villagers", "Werewolves", "Doctor", "Seer", "Hunter", "Witch"]) {
    expect(page).toContain(`${role}:* `);
  }
  expect(page).toContain("*Role selection*");
  expect(page).toContain("Games have at least 5 players");
  expect(page).toContain("randomly without replacement from Doctor, Seer, Hunter, and Witch");
  expect(page).toContain("Holds one healing potion and one poison for the whole game");
  expect(page).toContain("resolve it before checking either victory condition");
  expect(page).toContain("Every game starts on Day 1 as soon as roles are dealt");
  expect(page).toContain("one private inspection during Day 1, their only daytime inspection");
  expect(page).toContain("if Day 1 ends before they choose, it is skipped");
  expect(page).toContain("Public messages do not reveal whether a Seer exists or has acted");
  expect(page).not.toMatch(/opening|60–120/i);
  expect(page).toContain("private inspection history");
  expect(page).toContain("night-action dropdowns");
  expect(page).not.toContain("buttons");
  expect(page).toContain("*Day voting*");
  expect(page).toContain("5–12 players");
  expect(page).toContain("Vote publicly with `@werewolf vote @player`.");
  expect(page).toContain(votingRules());
  expect(page).toContain("A strict majority (more than half of living players) eliminates a player early");
  expect(page).toContain("once all living players vote, the unique leader (plurality) is eliminated");
  expect(page).toContain("a tie for the most votes eliminates nobody. Night then begins");
  expect(page).toContain("change your vote until a majority is reached or everyone has voted");
  expect(page).toContain("*Winning*");
  expect(page).toContain("*Lifetime stats*");
  expect(page).toContain("DM `stats` for your wins, losses, and games played by team");
  expect(page).toContain("`@werewolf stats`");
  expect(page).toContain("top 3 players by times assigned Werewolf");
  expect(page).toContain("dev games and bots are excluded");
  await open("T1", "home");
  expect(published).toHaveLength(2);
});
