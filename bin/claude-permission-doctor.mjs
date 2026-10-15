#!/usr/bin/env node
// claude-permission-doctor: why Claude Code asked, which permission rules are dead or shadowed, and
// which rules your history asks for. All the work lives in src/cli.mjs; run `claude-permission-doctor --help`.
import { main } from "../src/cli.mjs";

// `claude-permission-doctor show | head` closes the pipe early: that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
