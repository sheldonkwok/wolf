import {
  livingIds,
  livingWolves,
  pick,
  randomLivingOther,
  randomLivingVillager,
  villagerBotVote,
} from "../bots.js";
import type { ChannelStats, FinishedGame, PlayerStats } from "../db/index.js";
import { GameError, Rng, timeSeed } from "../engine.js";
import { Lobby, LobbyError } from "../lobby.js";
import { channelStats, personalStats } from "./stats.js";

export interface Choice {
  slackUser?: string;
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

const HELP =
  "In the game channel: `@werewolf join`, `leave`, `start`, `end`, `status`, `stats`, `vote @player`, or `help`. The first player is host; only the host starts or ends games. Use `@werewolf end` to cancel the game and open a fresh lobby. During the day, vote publicly with `@werewolf vote @player`. A strict majority (more than half of living players) eliminates a player early. Otherwise, once all living players vote, the unique leader (plurality) is eliminated; a tie for the most votes eliminates nobody. Night then begins. Repeat the command to change your vote before a majority is reached or everyone has voted. Every game starts on Day 1. A Seer may privately inspect one player during Day 1 using DM dropdowns; if Day 1 ends first, that inspection is skipped. Use DM dropdowns for the Seer's Day 1 inspection, night actions, and the Hunter's final shot. DM `status` to get your role, inspection history, and current prompt again. DM `stats` for your lifetime wins, losses, and team breakdowns; use `@werewolf stats` in the channel for team win rates and the top 3 most frequent wolves. Stats count completed games in this channel, excluding dev games and bots.";

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
          this.dm(input.user, `Vote in <#${this.channel}> with \`@werewolf vote @player\`.`);
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
        const { aliveVillagers, aliveWolves } = this.lobby.start(user).state();
        this.currentGame = { id: crypto.randomUUID(), startedAt: new Date() };
        this.prompt = crypto.randomUUID();
        this.publish(
          `The game has started with ${this.lobby.size} players. Teams: ${aliveWolves} ${aliveWolves === 1 ? "Werewolf" : "Werewolves"} and ${aliveVillagers} Villagers. Roles are in your DMs.`,
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
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const mention = /^vote\s+<@([A-Z0-9]+)(?:\|[^>]+)?>$/i.exec(command);
    const botSeat = this.dev ? /^vote\s+(\d+)$/i.exec(command) : null;
    const target = mention ? this.lobby.seatOf(mention[1]!) : botSeat ? Number(botSeat[1]) - 1 : null;
    if (!mention && !botSeat) throw new CommandError("Use `@werewolf vote @player` to mention one player.");
    if (target === null || !Number.isSafeInteger(target) || !this.lobby.memberAt(target))
      throw new CommandError("Unknown target. Mention a player in this game.");
    game.vote(seat, target);
    this.announceVote(seat, target);
    this.advance(target);
  }

  private announceVote(seat: number, target: number): void {
    const state = this.lobby.game!.state();
    const count = state.votes.filter((v) => v.target === target).length;
    this.publish(
      `${this.mention(seat)} voted for ${this.mention(target)} (${count}/${state.majorityRequired} votes for an early majority).`,
    );
  }

  private choose(user: string, value: string): void {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const [prompt, owner, targetText, extra] = value.split(":");
    if (prompt !== this.prompt || owner !== user || extra !== undefined || !/^\d+$/.test(targetText ?? "")) {
      throw new CommandError(
        "That choice is expired or belongs to another player. DM `status` for your current prompt.",
      );
    }
    const target = Number(targetText);
    if (!Number.isSafeInteger(target) || !this.lobby.memberAt(target))
      throw new CommandError("Unknown target.");
    const state = game.state();
    if (state.phase === "Hunter") {
      this.shoot(seat, target);
      this.advance();
      return;
    }
    if (state.phase === "Day") {
      const result = game.seerAction(seat, target);
      this.dm(
        user,
        `Your Day ${result.round} inspection: ${this.mention(result.target)} is ${result.isWerewolf ? "a Werewolf" : "innocent"}.`,
      );
      return;
    }
    if (state.phase === "Night") {
      switch (game.roleOf(seat)) {
        case "Doctor":
          game.doctorAction(seat, target);
          break;
        case "Seer": {
          const result = game.seerAction(seat, target);
          this.dm(
            user,
            `Your inspection: ${this.mention(result.target)} is ${result.isWerewolf ? "a Werewolf" : "innocent"}.`,
          );
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
      if (state.phase === "Day") {
        const seer = state.pendingInspectors[0];
        if (seer !== undefined && this.isBot(seer))
          game.seerAction(seer, randomLivingOther(state, this.rng, seer));
        if (state.majorityTarget == null && state.pendingActors.length > 0) {
          const humansAlive = state.players.some((p) => p.alive && !this.isBot(p.id));
          if (humansAlive && humanVote === null) return;
          const wolfVote = state.votes.find(
            (v) => !this.isBot(v.voter) && game.roleOf(v.voter) === "Werewolf",
          )?.target;
          const wolfTarget = wolfVote ?? randomLivingVillager(state, this.rng);
          for (const player of state.players.filter((p) => p.alive && this.isBot(p.id))) {
            const target =
              !humansAlive || player.role === "Werewolf"
                ? wolfTarget
                : villagerBotVote(state, this.rng, humanVote, player.id);
            game.vote(player.id, target);
            this.announceVote(player.id, target);
            const ballot = game.state();
            if (ballot.majorityTarget != null || ballot.pendingActors.length === 0) break;
          }
          const ballot = game.state();
          if (ballot.majorityTarget == null && ballot.pendingActors.length > 0) return;
        }
      } else {
        if (state.pendingActors.some((seat) => !this.isBot(seat))) return;
        const target = state.nightPicks[0]?.target ?? randomLivingVillager(state, this.rng);
        for (const seat of state.pendingActors) {
          switch (game.roleOf(seat)) {
            case "Doctor":
              game.doctorAction(seat, pick(this.rng, livingIds(state)));
              break;
            case "Seer":
              game.seerAction(seat, randomLivingOther(state, this.rng, seat));
              break;
            default:
              game.nightAction(seat, target);
          }
        }
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
      if (result.kind === "Saved")
        this.publish(
          `The Werewolves attacked ${this.mention(result.saved)}, but the Doctor saved them! No one was eliminated.`,
        );
      else this.elimination(result.killed, "during the night");
    } else {
      const result = game.resolveDay();
      this.prompt = crypto.randomUUID();
      if (result.kind === "Tied") this.publish("The most votes are tied. No one was eliminated.");
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
    if (state.phase === "Hunter") {
      this.publish("The Hunter has a final shot. Play pauses until they choose a target in their DMs.");
      this.promptActors();
    } else if (state.phase === "Night") {
      this.publish(`Night ${state.round}. The village sleeps. Players with night actions, check your DMs.`);
      this.promptActors();
    } else {
      this.publish(
        `Day ${state.round}. Discuss in <#${this.channel}> and vote with \`@werewolf vote @player\`. A strict majority of ${state.majorityRequired} votes eliminates a player early. Otherwise, once all living players vote, the unique leader (plurality) is eliminated; a tie for the most votes eliminates nobody. Night then begins. You can change your vote until a majority is reached or everyone has voted.${this.dev ? " To target a dev bot, use its player number: @werewolf vote 3." : ""}\n${this.livingRoster()}`,
      );
      this.promptActors();
    }
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
        : role === "Doctor"
          ? " Each night, protect one player, including yourself, from the werewolves. You win with the village."
          : role === "Seer"
            ? " During Day 1 only, you may inspect one living player privately; if Day 1 ends before you choose, that inspection is skipped. Each night, inspect one player to learn privately whether they are a werewolf or innocent. You win with the village."
            : role === "Hunter"
              ? " If eliminated, choose one living player to take down with your final shot. You win with the village."
              : " Find the werewolves through discussion and voting.";
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
        `${result.phase} ${result.round} inspection: ${this.mention(result.target)} is ${result.isWerewolf ? "a Werewolf" : "innocent"}.`,
      );
    }
    this.dm(user, this.status());
    const state = this.lobby.game.state();
    if (state.phase === "Day" && state.pendingInspectors.includes(seat)) {
      this.dm(
        user,
        "Your Day 1 inspection is available. Choose below before Day 1 ends or it will be skipped.",
      );
    }
    if (state.phase === "Night") {
      const player = state.players.find((player) => player.id === seat)!;
      const progress =
        !player.alive || player.role === "Villager" || player.role === "Hunter"
          ? `You have no action to take on Night ${state.round}.`
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
    if (state.phase === "Day") {
      const livingCount = state.players.filter((player) => player.alive).length;
      return `Day ${state.round}.\n${this.voteLeaderboard()}\nVote with \`@werewolf vote @player\`.\nLiving players: ${livingCount}.`;
    }
    const night =
      state.phase === "Night"
        ? "\nNight ends automatically once all living players with night actions have submitted their choices. DM `status` to check your own action or get your dropdown again."
        : "";
    return `${state.phase} ${state.round}.\n${this.livingRoster()}${night}`;
  }

  private voteLeaderboard(): string {
    const state = this.lobby.game!.state();
    const votersByTarget = new Map<number, number[]>();
    for (const { voter, target } of state.votes) {
      const voters = votersByTarget.get(target) ?? [];
      voters.push(voter);
      votersByTarget.set(target, voters);
    }
    const rows = [...votersByTarget.entries()]
      .sort(([a, av], [b, bv]) => bv.length - av.length || a - b)
      .map(
        ([target, voters]) =>
          `• ${this.mention(target)} — ${voters.length} ${voters.length === 1 ? "vote" : "votes"}\n  Voters: ${voters
            .sort((a, b) => a - b)
            .map((voter) => this.mention(voter))
            .join(", ")}`,
      );
    const voted = new Set(state.votes.map(({ voter }) => voter));
    const notVoted = state.players
      .filter((player) => player.alive && !voted.has(player.id))
      .map((player) => this.mention(player.id));
    return `Vote leaderboard (${state.majorityRequired} for an early majority; all living players voted: unique plurality is eliminated, top tie eliminates nobody):\n${rows.length ? rows.join("\n") : "No votes yet."}\nNot voted: ${notVoted.length ? notVoted.join(", ") : "Nobody"}.`;
  }

  private roster(): string {
    return `Lobby: ${this.lobby.size}/${Lobby.MAX_PLAYERS} players (${this.dev ? "dev mode: minimum 1 human, bots fill to 5" : `minimum ${Lobby.MIN_PLAYERS}`}). Host: ${this.lobby.host ? `<@${this.lobby.host.user}>` : "none"}.\n${this.lobby.members.map((_, seat) => this.mention(seat)).join(", ")}`;
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
