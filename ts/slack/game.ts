import { attempt, GameError, Rng, timeSeed } from "../engine.js";
import { randomLivingVillager, villagerBotVote } from "../bots.js";
import { Lobby, LobbyError } from "../lobby.js";

export interface Choice {
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

const HELP = "In the game channel: `@Wolf join`, `leave`, `start`, `status`, `vote`, `ready`, or `help`. The first player is host; only the host starts games. Tell me `ready to vote` in the game channel or a DM when you are ready. More than half of the living players must be ready to open elimination voting. Use the buttons in my DMs for secret choices. DM `status` to get your role and current prompt again.";

export class SlackGame {
  private readonly seen = new Set<string>();
  private prompt = "";
  private messages: SlackMessage[] = [];
  private readonly bots = new Set<string>();
  private readonly rng: Rng;
  private readonly dev: boolean;

  constructor(readonly channel: string, readonly lobby = new Lobby(), options: { dev?: boolean; seed?: bigint } = {}) {
    this.dev = options.dev ?? false;
    this.rng = new Rng(options.seed ?? timeSeed());
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
        const command = input.text.trim().toLowerCase();
        if (["vote", "ready", "ready to vote"].includes(command)) this.readyToVote(input.user);
        else this.privateStatus(input.user);
      }
      else this.command(input.user, input.text.trim().toLowerCase());
    } catch (error) {
      if (!(error instanceof LobbyError || error instanceof GameError || error instanceof CommandError)) throw error;
      this.messages.push({
        destination: input.kind === "mention" ? "ephemeral" : "dm",
        user: input.user,
        text: error.message,
      });
    }
    return this.messages;
  }

  private command(user: string, command: string): void {
    switch (command) {
      case "join":
        this.lobby.join(user, user);
        this.publish(`<@${user}> joined. ${this.roster()}`);
        break;
      case "leave":
        this.lobby.leave(user);
        this.publish(`<@${user}> left. ${this.roster()}`);
        break;
      case "start":
        if (!this.lobby.isHost(user)) throw new CommandError("Only the host can start the game.");
        if (this.lobby.game?.state().isOver) this.lobby.endGame();
        if (this.dev && !this.lobby.game) {
          while (this.lobby.size < Lobby.MIN_PLAYERS) {
            const user = `bot-${crypto.randomUUID()}`;
            this.lobby.join(user, `Bot ${this.bots.size + 1}`);
            this.bots.add(user);
          }
        }
        this.lobby.start(user);
        this.prompt = crypto.randomUUID();
        this.publish(`The game has started with ${this.lobby.size} players. Roles are in your DMs.`);
        for (const member of this.lobby.members) this.sendRole(member.user);
        this.announcePhase();
        this.advance();
        break;
      case "vote":
      case "ready":
      case "ready to vote":
        this.readyToVote(user);
        break;
      case "status":
        this.publish(this.status());
        break;
      case "help":
      case "":
        this.messages.push({ destination: "ephemeral", user, text: this.help() });
        break;
      default:
        throw new CommandError(this.help());
    }
  }

  private readyToVote(user: string): void {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    attempt(() => game.readyToVote(seat));
    this.readyBots();
    const state = game.state();
    this.dm(user, "You are ready to vote.");
    if (!state.votingOpen) {
      this.publish(`${state.readyPlayers.length}/${state.readinessRequired} players ready to open elimination voting. Use \`@Wolf ready\` or DM \`ready\` when you are ready.`);
      return;
    }
    this.openVoting();
    this.advance();
  }

  private openVoting(): void {
    this.prompt = crypto.randomUUID();
    this.publish("Voting is open. Living players: choose a player using the buttons in my DM. Votes are final.");
    this.promptActors();
  }

  private choose(user: string, value: string): void {
    const game = this.lobby.game;
    const seat = this.lobby.seatOf(user);
    if (!game || seat === null) throw new CommandError("You are not in an active game.");
    const [prompt, owner, targetText, extra] = value.split(":");
    if (prompt !== this.prompt || owner !== user || extra !== undefined || !/^\d+$/.test(targetText ?? "")) {
      throw new CommandError("That choice is expired or belongs to another player. DM `status` for your current prompt.");
    }
    const target = Number(targetText);
    if (!Number.isSafeInteger(target) || !this.lobby.memberAt(target)) throw new CommandError("Unknown target.");
    const state = game.state();
    if (state.phase === "Night") attempt(() => game.nightAction(seat, target));
    else if (state.phase === "Day" && state.votingOpen) attempt(() => game.vote(seat, target));
    else throw new CommandError("There is no choice to make right now.");
    this.dm(user, `Your ${state.phase === "Night" ? "night choice" : "vote"} for ${this.mention(target)} is recorded.`);
    this.advance();
  }

  private advance(): void {
    while (this.lobby.game) {
      const game = this.lobby.game;
      let state = game.state();
      if (state.phase === "Day" && !state.votingOpen) {
        if (state.players.some(p => p.alive && !this.isBot(p.id))) return;
        this.readyBots();
        if (!game.state().votingOpen) return;
        this.openVoting();
        state = game.state();
      }
      if (state.pendingActors.some(seat => !this.isBot(seat))) return;
      if (state.pendingActors.length > 0) {
        if (state.phase === "Night") {
          const target = state.nightPicks[0]?.target ?? randomLivingVillager(state, this.rng);
          for (const seat of state.pendingActors) attempt(() => game.nightAction(seat, target));
        } else {
          const humanVote = state.votes.find(v => !this.isBot(v.voter))?.target ?? null;
          const wolfVote = state.votes.find(v => !this.isBot(v.voter) && game.roleOf(v.voter) === "Werewolf")?.target;
          const wolfTarget = wolfVote ?? randomLivingVillager(state, this.rng);
          for (const seat of state.pendingActors) {
            const target = game.roleOf(seat) === "Werewolf" ? wolfTarget : villagerBotVote(state, this.rng, humanVote, seat);
            attempt(() => game.vote(seat, target));
          }
        }
      }
      if (!this.resolvePhase()) return;
    }
  }

  private readyBots(): void {
    const game = this.lobby.game!;
    for (const player of game.state().players) {
      if (game.state().votingOpen) break;
      if (player.alive && this.isBot(player.id) && !game.state().readyPlayers.includes(player.id)) {
        attempt(() => game.readyToVote(player.id));
      }
    }
  }

  private resolvePhase(): boolean {
    const game = this.lobby.game!;
    const state = game.state();

    if (state.phase === "Night") {
      const result = attempt(() => game.resolveNight());
      this.prompt = crypto.randomUUID();
      if (result.kind === "NoConsensus") {
        for (const actor of game.state().pendingActors) {
          this.dm(this.user(actor), `The pack disagreed (${result.targets.map(id => this.mention(id)).join(", ")}). Agree on one target and choose again.`);
        }
        this.promptActors();
        return false;
      }
      this.elimination(result.killed!, "during the night");
    } else {
      const result = attempt(() => game.resolveDay());
      this.prompt = crypto.randomUUID();
      if (result.kind === "Eliminated") this.elimination(result.eliminated!, "by the village");
      else this.publish("The vote was tied. Nobody was eliminated.");
    }
    this.announcePhase();
    return true;
  }

  private announcePhase(): void {
    const state = this.lobby.game!.state();
    if (state.isOver) {
      this.publish(`${state.winner} win!\n${state.players.map(p => `${this.mention(p.id)}: ${p.role}`).join("\n")}\nA new lobby is open! Use \`@Wolf join\` to play again. The first player to join becomes host and can use \`@Wolf start\` once everyone is ready.`);
      this.lobby.endGame();
      for (const { user } of [...this.lobby.members]) this.lobby.leave(user);
      this.bots.clear();
      this.prompt = "";
      return;
    }
    if (state.phase === "Night") {
      this.publish(`Night ${state.round}. The village sleeps. Werewolves, check your DMs.`);
      this.promptActors();
    } else {
      this.publish(`Day ${state.round}. Discuss in <#${this.channel}>. Use \`@Wolf ready\` or DM \`ready to vote\` when you are ready. Elimination voting opens when more than half of the living players are ready (${state.readinessRequired} needed).${this.dev ? " Dev bots add their readiness when a human is ready; one human is enough in a solo game." : ""}\n${this.livingRoster()}`);
    }
  }

  private promptActors(): void {
    for (const seat of this.lobby.game!.state().pendingActors) this.sendPrompt(this.user(seat));
  }

  private sendPrompt(user: string): void {
    if (this.bots.has(user)) return;
    const state = this.lobby.game!.state();
    const seat = this.lobby.seatOf(user)!;
    if (!state.pendingActors.includes(seat) || (state.phase === "Day" && !state.votingOpen)) return;
    this.messages.push({
      destination: "dm",
      user,
      text: `${state.phase} ${state.round}: ${state.phase === "Night" ? "choose the pack's target. All wolves must agree" : "choose who to eliminate. Your vote is final"}.\n${this.livingRoster()}`,
      choices: state.players.filter(p => p.alive).map(p => ({
        label: `Player ${p.id + 1}`,
        value: `${this.prompt}:${user}:${p.id}`,
      })),
    });
  }

  private sendRole(user: string): void {
    const game = this.lobby.game!;
    const seat = this.lobby.seatOf(user)!;
    const role = game.roleOf(seat);
    const pack = role === "Werewolf"
      ? ` Your pack: ${game.state().players.filter(p => p.role === "Werewolf").map(p => this.mention(p.id)).join(", ")}. Coordinate privately.`
      : " Find the werewolves through discussion and voting.";
    this.dm(user, `You are Player ${seat + 1}, a ${role}.${pack}${game.isAlive(seat) ? "" : " You were eliminated and are now a spectator."}`);
  }

  private privateStatus(user: string): void {
    if (!this.lobby.contains(user) || !this.lobby.game) {
      this.dm(user, `Join the next game with \`@Wolf join\` in <#${this.channel}>.\n${this.help()}`);
      return;
    }
    this.sendRole(user);
    this.dm(user, this.status());
    this.sendPrompt(user);
  }

  private status(): string {
    const state = this.lobby.game?.state();
    if (!state) return this.roster();
    return `${state.phase} ${state.round}${state.phase === "Day" ? state.votingOpen ? " — voting open" : ` — discussion (${state.readyPlayers.length}/${state.readinessRequired} ready to open voting)` : ""}.\n${this.livingRoster()}`;
  }

  private roster(): string {
    return `Lobby: ${this.lobby.size}/${Lobby.MAX_PLAYERS} players (${this.dev ? "dev mode: minimum 1 human, bots fill to 5" : `minimum ${Lobby.MIN_PLAYERS}`}). Host: ${this.lobby.host ? `<@${this.lobby.host.user}>` : "none"}.\n${this.lobby.members.map((_, seat) => this.mention(seat)).join(", ")}`;
  }

  private livingRoster(): string {
    return `Living players:\n${this.lobby.game!.state().players.filter(p => p.alive).map(p => `${p.id + 1}. ${this.mention(p.id)}`).join("\n")}`;
  }

  private elimination(seat: number, reason: string): void {
    this.publish(`${this.mention(seat)} was eliminated ${reason}. Their role was ${this.lobby.game!.roleOf(seat)}.`);
    this.dm(this.user(seat), "You were eliminated. You can watch the game, but can no longer act or vote.");
  }

  private user(seat: number): string { return this.lobby.memberAt(seat)!.user; }
  private isBot(seat: number): boolean { return this.bots.has(this.user(seat)); }
  private mention(seat: number): string { return this.isBot(seat) ? this.lobby.memberAt(seat)!.name : `<@${this.user(seat)}>`; }
  private help(): string { return `${HELP}${this.dev ? " Dev mode: start with one human; bots fill to five players and act automatically. Your readiness is enough to open voting in a solo game." : ""}`; }
  private publish(text: string): void { this.messages.push({ destination: "channel", text }); }
  private dm(user: string, text: string): void { if (!this.bots.has(user)) this.messages.push({ destination: "dm", user, text }); }
}

class CommandError extends Error {}
