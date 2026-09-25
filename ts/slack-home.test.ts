import { expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import manifest from "../slack/manifest.json";
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
  for (const role of ["Villager", "Werewolf", "Doctor", "Seer", "Hunter"]) {
    expect(page).toContain(`*${role}* —`);
  }
  expect(page).toContain("*Role selection*");
  expect(page).toContain("not every game includes every special role");
  expect(page).toContain("the Doctor cannot protect against the shot");
  expect(page).toContain("Play and victory checks wait for your shot");
  expect(page).toContain("one private inspection before Day 1");
  expect(page).toContain("no attacks, protection, or voting");
  expect(page).toContain("randomly timed 60–120-second opening, with or without a Seer");
  expect(page).toContain("Day 1 starts at the deadline, even if the Seer has not acted");
  expect(page).toContain("Acting early does not shorten the opening");
  expect(page).toContain("public messages do not reveal whether a Seer exists or has acted");
  expect(page).toContain("Inspect one living player during the timed opening before Day 1 and each night");
  expect(page).toContain("Missing the opening deadline skips only that inspection");
  expect(page).not.toContain("Without a Seer, Day 1 starts immediately");
  expect(page).toContain("private inspection history");
  expect(page).toContain("night-action dropdowns");
  expect(page).toContain("using DM dropdowns");
  expect(page).not.toContain("buttons");
  expect(page).toContain("*Day voting*");
  expect(page).toContain(
    "A strict majority (more than half of living players) eliminates a player immediately",
  );
  expect(page).toContain("once every living player has voted, the player with the most votes is eliminated");
  expect(page).toContain("A tie for the most votes eliminates nobody and night begins");
  expect(page).toContain("change your vote until a majority is reached or everyone has voted");
  expect(page).toContain("*Winning*");
  await open("T1", "home");
  expect(published).toHaveLength(2);
});
