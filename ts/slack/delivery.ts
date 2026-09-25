import type { SlackGame, SlackInput, SlackMessage } from "./game.js";

export class SlackDelivery {
  private readonly outbox: SlackMessage[] = [];
  private queue = Promise.resolve();

  constructor(
    private readonly game: SlackGame,
    private readonly send: (message: SlackMessage) => Promise<void>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  receive(input: SlackInput): Promise<void> {
    return this.enqueue(() => {
      this.outbox.push(...this.game.handle(input));
    });
  }

  retry(): Promise<void> {
    return this.enqueue(() => {});
  }

  private enqueue(command: () => void): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        command();
        this.game.saveResults();
        while (this.outbox.length > 0) {
          await this.send(this.outbox[0]!);
          this.outbox.shift();
        }
      })
      .catch(this.reportError);
    return this.queue;
  }
}
