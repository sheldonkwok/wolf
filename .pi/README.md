# Project checks

Run `/reload` in pi after adding or updating `.pi/extensions/checks.ts`, and trust the project if prompted.

The extension compares Git-listed source and configuration file contents before and after an agent run. Changes, additions, and deletions trigger these checks in order:

1. `bun run build:dev` builds Rust and regenerates the napi addon.
2. `cargo test` tests Rust, including doctests.
3. `bun run typecheck` checks TypeScript without emitting files.
4. `bun test` runs the TypeScript tests against the rebuilt addon.

Use `/check` to run all checks manually. Run pi from the repository root, with `bun install` completed and Rust and TypeScript (`tsc`) available.

Each step has a five-minute timeout. Failed steps are reported with bounded output, and subsequent steps still run. Results appear in the conversation without triggering an automatic fix loop. If the addon build fails, later Bun results may reflect the previous addon.

Documentation-only changes, ignored files, and changes inside `.pi/` do not trigger automatic checks. Shell-based edits are detected as well as edits made with pi's edit/write tools. This is a local feedback hook, not a substitute for CI or a commit gate.
