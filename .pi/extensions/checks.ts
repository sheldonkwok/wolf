import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, truncateTail } from "@earendil-works/pi-coding-agent";

const steps = [
  { name: "Rust/addon build", command: "bun", args: ["run", "build:dev"] },
  { name: "Rust tests", command: "cargo", args: ["test"] },
  { name: "TypeScript typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "TypeScript tests", command: "bun", args: ["test"] },
];

export default function (pi: ExtensionAPI) {
  let before: string | undefined;
  let running = false;

  async function fingerprint(ctx: ExtensionContext): Promise<string> {
    const files = await pi.exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ctx.cwd,
      timeout: 10_000,
    });
    if (files.code !== 0 || files.killed) throw new Error("Cannot inspect project files with git.");
    const paths = [...new Set(files.stdout.split("\0"))]
      .filter(
        (path) => /\.(rs|ts|tsx|js|mjs|cjs|json|toml|lock|patch)$/.test(path) && !path.startsWith(".pi/"),
      )
      .sort();
    const hash = createHash("sha256");
    for (const path of paths) {
      hash.update(path).update("\0");
      try {
        hash.update(await readFile(resolve(ctx.cwd, path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("<deleted>");
      }
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  async function check(ctx: ExtensionContext): Promise<void> {
    if (running) return;
    running = true;
    const report: string[] = [];
    try {
      for (const step of steps) {
        if (ctx.hasUI) ctx.ui.setStatus("wolf-checks", `Checking: ${step.name}`);
        try {
          const result = await pi.exec(step.command, step.args, {
            cwd: ctx.cwd,
            timeout: 300_000,
            signal: ctx.signal,
          });
          const passed = result.code === 0 && !result.killed;
          report.push(`${passed ? "PASS" : "FAIL"}: ${step.name}`);
          if (!passed) {
            const output = truncateTail(`${result.stdout}\n${result.stderr}`, {
              maxLines: 80,
              maxBytes: 8_000,
            });
            report.push(
              `Exit: ${result.code}; killed: ${result.killed}\n${output.content}${output.truncated ? "\n[Output truncated; rerun the command for full output.]" : ""}`,
            );
          }
          if (ctx.signal?.aborted) break;
        } catch (error) {
          report.push(`FAIL: ${step.name}: ${String(error)}`);
          if (ctx.signal?.aborted) break;
        }
      }
      pi.sendMessage({ customType: "wolf-checks", content: report.join("\n"), display: true });
    } finally {
      running = false;
      if (ctx.hasUI) ctx.ui.setStatus("wolf-checks", undefined);
    }
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    before = undefined;
    before = await fingerprint(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const previous = before;
    before = undefined;
    if (previous !== undefined && previous !== (await fingerprint(ctx))) await check(ctx);
  });

  pi.registerCommand("check", {
    description: "Build the Rust addon, test Rust, type-check TypeScript, and run Bun tests",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await check(ctx);
    },
  });
}
