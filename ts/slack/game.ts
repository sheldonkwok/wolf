import { attempt, GameError } from "../engine.js";
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

const HELP = "In the game channel: `@Wolf join`, `leave`, `start`, `status`, `vote`, or `help`. The first player is host; only the host starts games and opens voting after discussion. Use the buttons in my DMs for secret choices. DM `status` to get your role and current prompt again.";

export class SlackGame {
  private readonly seen = new Set<string>();
  private prompt = "";
  private voting = false;
  private messages: SlackMessage[] = [];

  constructor(readonly channel: string, readonly lobby = new Lobby()) {}

  handle(input: SlackInput): SlackMessage[] {
    this.messages = [];
    if (input.kind === "mention" ? input.channel !== this.channel : !input.channel.startsWith("D")) return [];
    if (this.seen.has(input.id)) return [];
    this.seen.add(input.id);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);

    try {
      if (input.kind === "choice") this.choose(input.user, input.value);
      else if (input.kind === "dm") this.privateStatus(input.user);
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
        this.lobby.start(user);
        this.voting = false;
        this.prompt = crypto.randomUUID();
        this.publish(`The game has started with ${this.lobby.size} players. Roles are in your DMs.`);
        for (const member of this.lobby.members) this.sendRole(member.user);
        this.announcePhase();
        break;
      case "vote": {
        if (!this.lobby.isHost(user)) throw new CommandError("Only the host can open voting.");
        if (this.lobby.game?.state().phase !== "Day") throw new CommandError("Voting opens during the day.");
        if (this.voting) throw new CommandError("Voting is already open.");
        this.voting = true;
        this.prompt = crypto.randomUUID();
        this.publish("Voting is open. Living players: choose a player using the buttons in my DM. Votes are final.");
        this.promptActors();
        break;
      }
      case "status":
        this.publish(this.status());
        break;
      case "help":
      case "":
        this.messages.push({ destination: "ephemeral", user, text: HELP });
        break;
      default:
        throw new CommandError(HELP);
    }
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
    else if (state.phase === "Day" && this.voting) attempt(() => game.vote(seat, target));
    else throw new CommandError("There is no choice to make right now.");
    this.dm(user, `Your ${state.phase === "Night" ? "night choice" : "vote"} for ${this.mention(target)} is recorded.`);
    if (game.state().pendingActors.length > 0) return;

    if (state.phase === "Night") {
      const result = attempt(() => game.resolveNight());
      this.prompt = crypto.randomUUID();
      if (result.kind === "NoConsensus") {
        for (const actor of game.state().pendingActors) {
          this.dm(this.user(actor), `The pack disagreed (${result.targets.map(id => this.mention(id)).join(", ")}). Agree on one target and choose again.`);
        }
        this.promptActors();
        return;
      }
      this.elimination(result.killed!, "during the night");
    } else {
      const result = attempt(() => game.resolveDay());
      this.prompt = crypto.randomUUID();
      this.voting = false;
      if (result.kind === "Eliminated") this.elimination(result.eliminated!, "by the village");
      else this.publish("The vote was tied. Nobody was eliminated.");
    }
    this.announcePhase();
  }

  private announcePhase(): void {
    const state = this.lobby.game!.state();
    if (state.isOver) {
      this.publish(`${state.winner} win!\n${state.players.map(p => `${this.mention(p.id)}: ${p.role}`).join("\n")}\nThe host can use \`@Wolf start\` to play again. Players can leave or join before the next game.`);
      this.lobby.endGame();
      return;
    }
    if (state.phase === "Night") {
      this.publish(`Night ${state.round}. The village sleeps. Werewolves, check your DMs.`);
      this.promptActors();
    } else {
      this.publish(`Day ${state.round}. Discuss in <#${this.channel}> for 3–5 minutes. <@${this.lobby.host!.user}> can use \`@Wolf vote\` when everyone is ready.\n${this.livingRoster()}`);
    }
  }

  private promptActors(): void {
    for (const seat of this.lobby.game!.state().pendingActors) this.sendPrompt(this.user(seat));
  }

  private sendPrompt(user: string): void {
    const state = this.lobby.game!.state();
    const seat = this.lobby.seatOf(user)!;
    if (!state.pendingActors.includes(seat) || (state.phase === "Day" && !this.voting)) return;
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
      this.dm(user, `Join the next game with \`@Wolf join\` in <#${this.channel}>.\n${HELP}`);
      return;
    }
    this.sendRole(user);
    this.dm(user, this.status());
    this.sendPrompt(user);
  }

  private status(): string {
    const state = this.lobby.game?.state();
    if (!state) return this.roster();
    return `${state.phase} ${state.round}${state.phase === "Day" ? this.voting ? " — voting open" : " — discussion" : ""}.\n${this.livingRoster()}`;
  }

  private roster(): string {
    return `Lobby: ${this.lobby.size}/${Lobby.MAX_PLAYERS} players (minimum ${Lobby.MIN_PLAYERS}). Host: ${this.lobby.host ? `<@${this.lobby.host.user}>` : "none"}.\n${this.lobby.members.map(m => `<@${m.user}>`).join(", ")}`;
  }

  private livingRoster(): string {
    return `Living players:\n${this.lobby.game!.state().players.filter(p => p.alive).map(p => `${p.id + 1}. ${this.mention(p.id)}`).join("\n")}`;
  }

  private elimination(seat: number, reason: string): void {
    this.publish(`${this.mention(seat)} was eliminated ${reason}. Their role was ${this.lobby.game!.roleOf(seat)}.`);
    this.dm(this.user(seat), "You were eliminated. You can watch the game, but can no longer act or vote.");
  }

  private user(seat: number): string { return this.lobby.memberAt(seat)!.user; }
  private mention(seat: number): string { return `<@${this.user(seat)}>`; }
  private publish(text: string): void { this.messages.push({ destination: "channel", text }); }
  private dm(user: string, text: string): void { this.messages.push({ destination: "dm", user, text }); }
}

class CommandError extends Error {}
