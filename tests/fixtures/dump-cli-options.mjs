// Preloaded with `node --import` before bin/oracle-cli.ts: print the root Commander options as JSON
// instead of parsing argv, so tests can compare help output against the real option definitions.
import { Command } from "commander";

function dumpOptions() {
  const options = this.options.map((option) => ({ long: option.long, hidden: option.hidden }));
  process.stdout.write(`${JSON.stringify(options)}\n`, () => {
    process.exit(0);
  });
}

Command.prototype.parse = dumpOptions;
Command.prototype.parseAsync = dumpOptions;
