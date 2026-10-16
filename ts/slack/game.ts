import {
  ballotClosed,
  botDayInspection,
  botDayVotes,
  botNightActions,
  botSheriffVotes,
  livingIds,
  livingWolves,
  pick,
} from "../bots.js";
import type { ChannelStats, FinishedGame, PlayerStats } from "../db/index.js";
import { GameError, type GameState, Rng, timeSeed } from "../engine.js";
import { Lobby, LobbyError } from "../lobby.js";
import { verdict } from "../render.js";
import {
  LAST_WORDS_COMMAND,
  SHERIFF_COMMAND,
  structuredRules,
  VOTE_COMMAND,
  votingRules,
  votingSummary,
} from "./copy.js";
import { roleBlurb } from "./rules.js";
import { channelStats, personalStats } from "./stats.js";

export interface Choice {
  slackUser?: string;
  // Shown before the label, which may be replaced by the player's Slack name.
  prefix?: string;
  label: string;
  value: string;
}

export interface SlackMessage {
  destination: "channel" | "dm" | "ephemeral";
  user?: string;
  text: string;
  choices?: Choice[];
}

export type SlackInput = {
  id: string;
  user: string;
  channel: string;
} & ({ kind: "mention" | "dm"; text: string } | { kind: "choice"; value: string });

const HELP = `In the game channel: \`@werewolf join\`, \`leave\`, \`start\`, \`end\`, \`status\`, \`stats\`, \`vote @player\`, \`sheriff @player\`, \`last words <message>\`, or \`help\`. The first player is host; only the host starts or ends games. Use \`@werewolf end\` to cancel the game and open a fresh lobby. During the day, vote publicly with ${VOTE_COMMAND}. ${votingRules()} Every game starts on Day 1. A Seer may privately inspect one player during Day 1 using DM dropdowns; if Day 1 ends first, that inspection is skipped. Use DM dropdowns for the Seer's Day 1 inspection, night actions, and the Hunter's final shot. ${structuredRules()} DM \`status\` to get your role, inspection history, and current prompt again. DM \`stats\` for your lifetime wins, losses, and team breakdowns; use \`@werewolf stats\` in the channel for team win rates and the top 3 most frequent wolves. Stats count completed games in this channel, excluding dev games and bots.`;

export class SlackGame {
  private readonly seen = new Set<string>();
  private prompt = "";
  private messages: SlackMessage[] = [];
  private readonly bots = new Set<string>();
  private readonly rng: Rng;
  private readonly dev: boolean;
  private currentGame: { id: string; startedAt: Date } | null = null;
  private readonly results: FinishedGame[] = [];

  constructor(
    readonly channel: string,
    readonly lobby = new Lobby(),
    private readonly options: {
      dev?: boolean;
      seed?: bigint;
      recordResult?: (result: FinishedGame) => void;
      playerStats?: (user: string) => PlayerStats;
      channelStats?: () => ChannelStats;
    } = {},
  ) {
    this.dev = options.dev ?? false;
    this.rng = new Rng(options.seed ?? timeSeed());
  }

  saveResults(): void {
    while (this.results.length > 0) {
      this.options.recordResult!(this.results[0]!);
      this.results.shift();
    }
  }

  handle(input: SlackInput): SlackMessage[] {
    this.messages = [];
    if (input.kind === "mention" ? input.channel !== this.channel : !input.channel.startsWith("D")) return [];
    if (this.seen.has(input.id)) return [];
    this.seen.add(input.id);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);

    try {
      if (input.kind === "choice") this.choose(input.user, input.value);
      else if (input.kind === "dm") {
        if (input.text.trim().toLowerCase() === "stats") {
          this.dm(
            input.user,
            this.options.playerStats
              ? personalStats(this.channel, this.options.playerStats(input.user))
              : "Stats are unavailable right now.",
          );
        } else if (/^(vote|ready)\b/i.test(input.text.trim())) {
          this.dm(input.user, `Vote in <#${this.channel}> with ${VOTE_COMMAND}.`);
        } else this.privateStatus(input.user);
      } else this.command(input.user, input.text.trim());
    } catch (error) {
      if (!(error instanceof LobbyError || error instanceof GameError || error instanceof CommandError))
        throw error;
      this.messages.push({
        destination: input.kind === "mention" ? "ephemeral" : "dm",
        user: input.user,
        text: error.message,
      });
    }
    return this.messages;
  }

  private command(user: string, command: string): void {
    if (/^vote\b/i.test(command)) {
      this.publicVote(user, command);
      return;
    }
    if (/^sheriff\b/i.test(command)) {
      this.sheriffVote(user, command);
      return;
    }
    if (/^last\s*words\b/i.test(command)) {
      this.lastWords(user, command);
      return;
    }
    switch (command.toLowerCase()) {
      case "join":
        this.lobby.join(user, user);
        this.publish(`<@${user}> joined. ${this.roster()}`);
        break;
      case "leave":
        this.lobby.leave(user);
        this.publish(`<@${user}> left. ${this.roster()}`);
        break;
      case "start": {
        if (!this.lobby.isHost(user)) throw new CommandError("Only the host can start the game.");
        if (this.lobby.game?.state().isOver) this.lobby.endGame();
        if (this.dev && !this.lobby.game) {
          while (this.lobby.size < Lobby.MIN_PLAYERS) {
            const user = `bot-${crypto.randomUUID()}`;
            this.lobby.join(user, `Bot ${this.bots.size + 1}`);
            this.bots.add(user);
          }
        }
        const { aliveVillagers, aliveWolves, ruleset } = this.lobby.start(user).state();
        this.currentGame = { id: crypto.randomUUID(), startedAt: new Date() };
        this.prompt = crypto.randomUUID();
        this.publish(
          `The game has started with ${this.lobby.size} players. Teams: ${aliveWolves} ${aliveWolves === 1 ? "Werewolf" : "Werewolves"} and ${aliveVillagers} Villagers. Roles are in your DMs.${ruleset === "Structured" ? ` ${structuredRules()}` : ""}`,
        );
        for (const member of this.lobby.members) this.sendRole(member.user);
        this.announcePhase();
        this.advance();
        break;
      }
      case "end":
        this.lobby.cancelGame(user);
        this.resetLobby();
        this.publish(
          `<@${user}> ended the game. No winner was declared. A new lobby is open! Use \`@werewolf join\` to play again; the first player to join becomes host.`,
        );
        break;
      case "status":
        this.publish(this.status());
        break;
      case "stats":
        this.publish(
          this.options.channelStats
            ? channelStats(this.channel, this.options.channelStats())
            : "Stats are unavailable right now.",
        );
        break;
      case "help":
      case "":
        this.messages.push({ destination: "ephemeral", user, text: this.help() });
        break;
      default:
        throw new CommandError(this.help());
    }
  }

  private publicVote(user: string, command: string): void {
    const { game, seat, target } = this.ballotTarget(user, command, "vote", VOTE_COMMAND);
    const player = game.state().players[seat]!;
    if (player.alive && !player.canVote)
      throw new CommandError("You were revealed as the Fool and can no longer vote.");
    game.vote(seat, target);
    this.announceVote(seat, target);
    this.advance(target);
  }

  private sheriffVote(user: string, command: string): void {
    const { game, seat, target } = this.ballotTarget(user, command, "sheriff", SHERIFF_COMMAND);
    if (game.state().phase !== "Sheriff") throw new CommandError("There is no sheriff election right now.");
    game.sheriffVote(seat, target);
    this.announceSheriffVote(seat, target);
    this.advance(target);
  }

  // Parse `<verb> @player`, or a dev bot's player number, into the caller's seat and target seat.
  private ballotTarget(user: string, command: string, verb: string, usage: string) {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const mention = new RegExp(`^${verb}\\s+<@([A-Z0-9]+)(?:\\|[^>]+)?>$`, "i").exec(command);
    const botSeat = this.dev ? new RegExp(`^${verb}\\s+(\\d+)$`, "i").exec(command) : null;
    const target = mention ? this.lobby.seatOf(mention[1]!) : botSeat ? Number(botSeat[1]) - 1 : null;
    if (!mention && !botSeat) throw new CommandError(`Use ${usage} to mention one player.`);
    if (target === null || !Number.isSafeInteger(target) || !this.lobby.memberAt(target))
      throw new CommandError("Unknown target. Mention a player in this game.");
    return { game, seat, target };
  }

  private lastWords(user: string, command: string): void {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const words = /^last\s*words\s+([\s\S]+)$/i.exec(command)?.[1]?.trim();
    if (!words) throw new CommandError(`Use ${LAST_WORDS_COMMAND} to share your last words.`);
    if (!game.state().lastWords.includes(seat))
      throw new CommandError(
        "Only players eliminated on Night 1 of a 12-player game may share last words, once, before Day 2 ends.",
      );
    game.lastWords(seat);
    this.publish(`Last words from ${this.mention(seat)}: ${words}`);
  }

  private announceVote(seat: number, target: number): void {
    const state = this.lobby.game!.state();
    this.publish(
      `${this.mention(seat)} voted for ${this.mention(target)} (${tally(state, state.votes, target)}/${state.majorityRequired} votes for an early majority).`,
    );
  }

  private announceSheriffVote(seat: number, target: number): void {
    const state = this.lobby.game!.state();
    this.publish(
      `${this.mention(seat)} voted for ${this.mention(target)} as sheriff (${tally(state, state.sheriffVotes, target)}/${state.majorityRequired} votes to elect early).`,
    );
  }

  private choose(user: string, value: string): void {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const [prompt, owner, targetText, extra] = value.split(":");
    const state = game.state();
    const potion = state.phase === "Night" && game.roleOf(seat) === "Witch";
    const valid = potion ? /^(\d+|heal|pass)$/ : /^\d+$/;
    if (prompt !== this.prompt || owner !== user || extra !== undefined || !valid.test(targetText ?? "")) {
      throw new CommandError(
        "That choice is expired or belongs to another player. DM `status` for your current prompt.",
      );
    }
    if (targetText === "heal" || targetText === "pass") {
      if (targetText === "heal") {
        game.witchHeal(seat);
        this.dm(user, "You used your healing potion on the attacked player. It is now spent.");
      } else {
        game.witchPass(seat);
        this.dm(user, "You kept your potions tonight.");
      }
      this.advance();
      return;
    }
    const target = Number(targetText);
    if (!Number.isSafeInteger(target) || !this.lobby.memberAt(target))
      throw new CommandError("Unknown target.");
    if (state.phase === "Hunter") {
      this.shoot(seat, target);
      this.advance();
      return;
    }
    if (state.phase === "Day") {
      const result = game.seerAction(seat, target);
      this.dm(
        user,
        `Your Day ${result.round} inspection: ${this.mention(result.target)} is ${verdict(result.isWerewolf)}.`,
      );
      return;
    }
    if (state.phase === "Night") {
      switch (game.roleOf(seat)) {
        case "Witch":
          game.witchPoison(seat, target);
          this.dm(user, `You poisoned ${this.mention(target)}. Your poison is now spent.`);
          this.advance();
          return;
        case "Doctor":
          game.doctorAction(seat, target);
          break;
        case "Seer": {
          const result = game.seerAction(seat, target);
          this.dm(user, `Your inspection: ${this.mention(result.target)} is ${verdict(result.isWerewolf)}.`);
          break;
        }
        default:
          game.nightAction(seat, target);
      }
    } else throw new CommandError("There is no choice to make right now.");
    this.dm(user, `Your night choice for ${this.mention(target)} is recorded.`);
    this.advance();
  }

  private advance(humanVote: number | null = null): void {
    const isBot = (seat: number) => this.isBot(seat);
    while (this.lobby.game) {
      const game = this.lobby.game;
      const state = game.state();
      if (state.phase === "Hunter") {
        const hunter = state.pendingActors[0]!;
        if (!this.isBot(hunter)) return;
        this.shoot(hunter, pick(this.rng, livingIds(state)));
        humanVote = null;
        continue;
      }
      if (state.phase === "Sheriff") {
        if (!ballotClosed(state)) {
          if (humanVote === null && state.players.some((p) => !this.isBot(p.id))) return;
          botSheriffVotes(game, this.rng, isBot, humanVote, (voter, target) =>
            this.announceSheriffVote(voter, target),
          );
          if (!ballotClosed(game.state())) return;
        }
      } else if (state.phase === "Day") {
        botDayInspection(game, this.rng, isBot);
        if (!ballotClosed(state)) {
          const humansAlive = state.players.some((p) => p.alive && !this.isBot(p.id));
          if (humansAlive && humanVote === null) return;
          botDayVotes(game, this.rng, isBot, humanVote, (voter, target) => this.announceVote(voter, target));
          if (!ballotClosed(game.state())) return;
        }
      } else {
        if (state.pendingActors.some((seat) => !this.isBot(seat))) return;
        botNightActions(game, this.rng, isBot);
      }
      if (!this.resolvePhase()) return;
      humanVote = null;
    }
  }

  private shoot(hunter: number, target: number): void {
    this.lobby.game!.hunterAction(hunter, target);
    this.prompt = crypto.randomUUID();
    this.elimination(target, "by the Hunter's final shot");
    this.announcePhase();
  }

  private resolvePhase(): boolean {
    const game = this.lobby.game!;
    const state = game.state();

    if (state.phase === "Night") {
      const result = game.resolveNight();
      this.prompt = crypto.randomUUID();
      if (result.kind === "NoConsensus") {
        for (const actor of game.state().pendingActors) {
          this.dm(
            this.user(actor),
            `The pack disagreed (${result.targets.map((id) => this.mention(id)).join(", ")}). Agree on one target and choose again.`,
          );
        }
        this.promptActors();
        return false;
      }
      if (result.kind === "AwaitingWitch") {
        // The witch's turn is private: nothing is announced until the night is over.
        this.promptActors();
        return true;
      }
      if (result.saved !== null)
        this.publish(
          `The Werewolves attacked ${this.mention(result.saved)}, but they were saved!${result.deaths.length ? "" : " No one was eliminated."}`,
        );
      for (const seat of result.deaths) this.elimination(seat, "during the night");
      this.inviteLastWords();
    } else if (state.phase === "Sheriff") {
      const result = game.resolveSheriff();
      this.prompt = crypto.randomUUID();
      this.publish(
        result.kind === "Elected"
          ? `${this.mention(result.sheriff)} is elected sheriff! Their day vote counts as 1.5 votes.`
          : "The sheriff vote is tied. There is no sheriff this game.",
      );
    } else {
      const result = game.resolveDay();
      this.prompt = crypto.randomUUID();
      if (result.kind === "Tied") this.publish("The most votes are tied. No one was eliminated.");
      else if (result.kind === "FoolRevealed")
        this.publish(
          `${this.mention(result.fool)} was voted out, but they are the Fool! They stay in the game but can no longer vote.`,
        );
      else this.elimination(result.eliminated, "by the village");
    }
    this.announcePhase();
    return true;
  }

  private announcePhase(): void {
    const state = this.lobby.game!.state();
    if (state.isOver) {
      if (this.options.recordResult) {
        this.results.push({
          ...this.currentGame!,
          channelId: this.channel,
          finishedAt: new Date(),
          winner: state.winner!,
          dev: this.dev,
          players: state.players.map((player) => ({
            seat: player.id,
            userId: this.user(player.id),
            role: player.role,
            isBot: this.isBot(player.id),
          })),
        });
      }
      this.publish(
        `${state.winner} win!\n${state.players.map((p) => `${this.mention(p.id)}: ${p.role}`).join("\n")}\nA new lobby is open! Use \`@werewolf join\` to play again. The first player to join becomes host and can use \`@werewolf start\` once everyone is ready.`,
      );
      this.lobby.endGame();
      this.resetLobby();
      return;
    }
    if (state.phase === "Sheriff") {
      this.publish(
        `Sheriff election. Every living player votes with ${SHERIFF_COMMAND}. The sheriff's day vote counts as 1.5 votes. ${state.majorityRequired} votes elect early; otherwise the unique leader wins once everyone has voted, and a tie means no sheriff. Repeat the command to change your vote.${this.dev ? " To vote for a dev bot, use its player number: @werewolf sheriff 3." : ""}\n${this.livingRoster()}`,
      );
    } else if (state.phase === "Hunter") {
      this.publish("The Hunter has a final shot. Play pauses until they choose a target in their DMs.");
      this.promptActors();
    } else if (state.phase === "Night") {
      this.publish(`Night ${state.round}. The village sleeps. Players with night actions, check your DMs.`);
      this.promptActors();
    } else {
      this.publish(
        `Day ${state.round}. Discuss in <#${this.channel}> and vote with ${VOTE_COMMAND}. ${votingRules(state.majorityRequired)}${state.sheriff == null ? "" : ` Sheriff ${this.mention(state.sheriff)}'s vote counts as 1.5 votes.`}${state.revealedFool == null || !state.players[state.revealedFool]!.alive ? "" : ` ${this.mention(state.revealedFool)} is the revealed Fool and cannot vote.`}${this.dev ? " To target a dev bot, use its player number: @werewolf vote 3." : ""}\n${this.livingRoster()}`,
      );
      this.promptActors();
    }
  }

  // Night 1 victims of a structured game may speak once before Day 2 ends.
  private inviteLastWords(): void {
    const speakers = this.lobby.game!.state().lastWords.filter((seat) => !this.isBot(seat));
    if (speakers.length === 0) return;
    this.publish(
      `${speakers.map((seat) => this.mention(seat)).join(" and ")} may share last words once with ${LAST_WORDS_COMMAND} before Day 2 ends.`,
    );
    for (const seat of speakers)
      this.dm(
        this.user(seat),
        `You were eliminated on the first night. Share your last words once in <#${this.channel}> with ${LAST_WORDS_COMMAND} before Day 2 ends.`,
      );
  }

  private resetLobby(): void {
    for (const { user } of [...this.lobby.members]) this.lobby.leave(user);
    this.bots.clear();
    this.currentGame = null;
    this.prompt = "";
  }

  private promptActors(): void {
    const state = this.lobby.game!.state();
    const actors = state.phase === "Day" ? state.pendingInspectors : state.pendingActors;
    for (const seat of actors) this.sendPrompt(this.user(seat));
  }

  private sendPrompt(user: string): void {
    if (this.bots.has(user)) return;
    const state = this.lobby.game!.state();
    const seat = this.lobby.seatOf(user)!;
    const actors = state.phase === "Day" ? state.pendingInspectors : state.pendingActors;
    if (!["Day", "Night", "Hunter"].includes(state.phase) || !actors.includes(seat)) return;
    const role = this.lobby.game!.roleOf(seat);
    if (role === "Witch" && state.phase === "Night") {
      this.sendWitchPrompt(user, seat);
      return;
    }
    const excludeSelf = role === "Werewolf" && livingWolves(state).length === 1;
    const instruction =
      role === "Hunter"
        ? "choose one living player for your final shot. Your choice is final"
        : role === "Doctor"
          ? "choose someone to protect, including yourself. Your choice is final"
          : role === "Seer"
            ? "choose someone to inspect. Only you will receive the result. Your choice is final"
            : "choose the pack's target. All wolves must agree";
    this.messages.push({
      destination: "dm",
      user,
      text: `${state.phase} ${state.round}: ${instruction}.${state.phase === "Day" ? " This is your only daytime inspection; if Day 1 ends before you choose, it is skipped. It does not use your Night 1 inspection." : ""}\n${this.livingRoster()}`,
      choices: state.players
        .filter((p) => p.alive && (!excludeSelf || p.id !== seat))
        .map((p) => ({
          label: this.isBot(p.id) ? this.lobby.memberAt(p.id)!.name : this.user(p.id),
          ...(this.isBot(p.id) ? {} : { slackUser: this.user(p.id) }),
          value: `${this.prompt}:${user}:${p.id}`,
        })),
    });
  }

  // The witch sees the attacked player only while she still holds the healing potion.
  private sendWitchPrompt(user: string, seat: number): void {
    const state = this.lobby.game!.state();
    const victim = state.witchVictim;
    const attack =
      victim === undefined
        ? "Your healing potion is spent, so you are not told who was attacked."
        : `The Werewolves attacked ${victim === seat ? "you" : this.mention(victim)}.`;
    const options = [
      ...(victim === undefined ? [] : [`heal ${victim === seat ? "yourself" : "them"}`]),
      ...(state.poisonAvailable ? ["poison another player"] : []),
      "do nothing",
    ];
    const choices: Choice[] = [];
    if (victim !== undefined)
      choices.push({ label: "Heal the attacked player", value: `${this.prompt}:${user}:heal` });
    choices.push({ label: "Do nothing", value: `${this.prompt}:${user}:pass` });
    if (state.poisonAvailable) {
      for (const p of state.players) {
        if (!p.alive || p.id === seat) continue;
        choices.push({
          prefix: "Poison ",
          label: this.isBot(p.id) ? this.lobby.memberAt(p.id)!.name : this.user(p.id),
          ...(this.isBot(p.id) ? {} : { slackUser: this.user(p.id) }),
          value: `${this.prompt}:${user}:${p.id}`,
        });
      }
    }
    this.messages.push({
      destination: "dm",
      user,
      text: `Night ${state.round}: ${attack} Choose one: ${options.join(", ")}. You may use only one potion per night, and your choice is final.\n${this.livingRoster()}`,
      choices,
    });
  }

  private sendRole(user: string): void {
    const game = this.lobby.game!;
    const seat = this.lobby.seatOf(user)!;
    const role = game.roleOf(seat);
    const pack =
      role === "Werewolf"
        ? ` Your pack: ${game
            .state()
            .players.filter((p) => p.role === "Werewolf")
            .map((p) => this.mention(p.id))
            .join(", ")}. Coordinate privately.`
        : ` ${roleBlurb(role)}`;
    this.dm(
      user,
      `You are Player ${seat + 1}, a ${role}.${pack}${game.isAlive(seat) ? "" : " You were eliminated and are now a spectator."}`,
    );
  }

  private privateStatus(user: string): void {
    if (!this.lobby.contains(user) || !this.lobby.game) {
      this.dm(user, `Join the next game with \`@werewolf join\` in <#${this.channel}>.\n${this.help()}`);
      return;
    }
    this.sendRole(user);
    const seat = this.lobby.seatOf(user)!;
    for (const result of this.lobby.game.state().inspections.filter((result) => result.seer === seat)) {
      this.dm(
        user,
        `${result.phase} ${result.round} inspection: ${this.mention(result.target)} is ${verdict(result.isWerewolf)}.`,
      );
    }
    this.dm(user, this.status());
    const state = this.lobby.game.state();
    const role = this.lobby.game.roleOf(seat);
    if (role === "Witch") {
      this.dm(
        user,
        `Healing potion: ${state.healAvailable ? "ready" : "spent"}. Poison: ${state.poisonAvailable ? "ready" : "spent"}.`,
      );
    }
    if (state.phase === "Day" && state.pendingInspectors.includes(seat)) {
      this.dm(
        user,
        "Your Day 1 inspection is available. Choose below before Day 1 ends or it will be skipped.",
      );
    }
    if (state.phase === "Night") {
      const player = state.players.find((player) => player.id === seat)!;
      const spent = role === "Witch" && !state.healAvailable && !state.poisonAvailable;
      const progress =
        !player.alive || ["Villager", "Hunter", "Fool"].includes(player.role) || spent
          ? `You have no action to take on Night ${state.round}.`
          : role === "Witch" && !state.pendingActors.includes(seat)
            ? `Your Night ${state.round} turn comes after the Werewolves choose. You will get a dropdown then.`
            : state.pendingActors.includes(seat)
              ? `Your Night ${state.round} action is still needed. Choose using the dropdown below.`
              : `Your Night ${state.round} action is recorded. Waiting for the remaining night actions.`;
      this.dm(user, progress);
    }
    this.sendPrompt(user);
  }

  private status(): string {
    const state = this.lobby.game?.state();
    if (!state) return this.roster();
    const livingCount = state.players.filter((player) => player.alive).length;
    if (state.phase === "Sheriff") {
      return `Sheriff election.\n${this.leaderboard(state.sheriffVotes, "Sheriff votes", `${state.majorityRequired} to elect early; all voted: unique leader wins, tie means no sheriff`)}\nVote with ${SHERIFF_COMMAND}.\nLiving players: ${livingCount}.`;
    }
    if (state.phase === "Day") {
      return `Day ${state.round}.\n${this.leaderboard(state.votes, "Vote leaderboard", votingSummary(state.majorityRequired))}\nVote with ${VOTE_COMMAND}.${state.sheriff == null ? "" : `\nSheriff: ${this.mention(state.sheriff)} (vote counts 1.5).`}\nLiving players: ${livingCount}.`;
    }
    const night =
      state.phase === "Night"
        ? "\nNight ends automatically once all living players with night actions have submitted their choices. DM `status` to check your own action or get your dropdown again."
        : "";
    return `${state.phase} ${state.round}.\n${this.livingRoster()}${night}`;
  }

  private leaderboard(votes: GameState["votes"], title: string, summary: string): string {
    const state = this.lobby.game!.state();
    const votersByTarget = new Map<number, number[]>();
    for (const { voter, target } of votes) {
      const voters = votersByTarget.get(target) ?? [];
      voters.push(voter);
      votersByTarget.set(target, voters);
    }
    const rows = [...votersByTarget.keys()]
      .map((target) => [target, tally(state, votes, target), votersByTarget.get(target)!] as const)
      .sort(([a, av], [b, bv]) => bv - av || a - b)
      .map(
        ([target, count, voters]) =>
          `• ${this.mention(target)} — ${count} ${count === 1 ? "vote" : "votes"}\n  Voters: ${voters
            .sort((a, b) => a - b)
            .map((voter) => this.mention(voter))
            .join(", ")}`,
      );
    const voted = new Set(votes.map(({ voter }) => voter));
    const notVoted = state.players
      .filter((player) => player.canVote && !voted.has(player.id))
      .map((player) => this.mention(player.id));
    return `${title} (${summary}):\n${rows.length ? rows.join("\n") : "No votes yet."}\nNot voted: ${notVoted.length ? notVoted.join(", ") : "Nobody"}.`;
  }

  private roster(): string {
    return `Lobby: ${this.lobby.size}/${Lobby.MAX_PLAYERS} players (${this.dev ? `dev mode: minimum 1 human, bots fill to ${Lobby.MIN_PLAYERS}` : `minimum ${Lobby.MIN_PLAYERS}`}). Host: ${this.lobby.host ? `<@${this.lobby.host.user}>` : "none"}.\n${this.lobby.members.map((_, seat) => this.mention(seat)).join(", ")}`;
  }

  private livingRoster(): string {
    return `Living players:\n${this.lobby
      .game!.state()
      .players.filter((p) => p.alive)
      .map((p) => `${p.id + 1}. ${this.mention(p.id)}`)
      .join("\n")}`;
  }

  private elimination(seat: number, reason: string): void {
    this.publish(
      `${this.mention(seat)} was eliminated ${reason}. Their role was ${this.lobby.game!.roleOf(seat)}.`,
    );
    this.dm(
      this.user(seat),
      this.lobby.game!.state().phase === "Hunter" && this.lobby.game!.roleOf(seat) === "Hunter"
        ? "You were eliminated, but you must take your final shot. Choose a living player using the dropdown."
        : "You were eliminated. You can watch the game, but can no longer act or vote.",
    );
  }

  private user(seat: number): string {
    return this.lobby.memberAt(seat)!.user;
  }
  private isBot(seat: number): boolean {
    return this.bots.has(this.user(seat));
  }
  private mention(seat: number): string {
    return this.isBot(seat) ? this.lobby.memberAt(seat)!.name : `<@${this.user(seat)}>`;
  }
  private help(): string {
    return `${HELP}${this.dev ? " Dev mode: start with one human; bots fill to five players and act automatically. Use `@werewolf vote 3` to target a dev bot by player number." : ""}`;
  }
  private publish(text: string): void {
    this.messages.push({ destination: "channel", text });
  }
  private dm(user: string, text: string): void {
    if (!this.bots.has(user)) this.messages.push({ destination: "dm", user, text });
  }
}

class CommandError extends Error {}

// The weighted votes for `target`, counting the sheriff's day vote as 1.5.
function tally(state: GameState, votes: GameState["votes"], target: number): number {
  return votes
    .filter((v) => v.target === target)
    .reduce((sum, v) => sum + state.players[v.voter]!.voteWeight, 0);
}
