import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
let oracleHome: string;

beforeAll(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-help-"));
});
afterAll(async () => {
  await rm(oracleHome, { recursive: true, force: true });
});

async function help(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "bin/oracle-cli.ts"), ...args],
    {
      env: { ...process.env, ORACLE_HOME_DIR: oracleHome, ORACLE_FORCE_TUI: "0", NO_COLOR: "1" },
      timeout: 15_000,
    },
  );
  expect(await readdir(oracleHome)).toEqual([]);
  return stdout;
}

test.each([
  ["--help", "--verbose"],
  ["--verbose", "--help"],
  ["-h", "--verbose"],
])(
  "shows advanced help for %j",
  async (...args) => {
    const output = await help(args);
    expect(output).toContain("Usage:");
    expect(output).toContain("Advanced Options");
    expect(output).toContain("Browser Options");
    expect(output).toContain("--browser-cookie-path");
  },
  20_000,
);

test("keeps plain and subcommand help concise", async () => {
  expect(await help(["--help"])).not.toContain("Advanced Options");
  const subcommand = await help(["status", "--help", "--verbose"]);
  expect(subcommand).toContain("Usage:");
  expect(subcommand).not.toContain("Advanced Options");
}, 20_000);

test("keeps the explicit debug-help entrypoint", async () => {
  expect(await help(["--debug-help"])).toContain("Advanced Options");
}, 20_000);

// Hidden aliases, deprecated spellings, and internal flags that stay out of advanced help.
const UNLISTED_HIDDEN_FLAGS = [
  "--message",
  "--include",
  "--files",
  "--path",
  "--paths",
  "--mode",
  "--preview",
  "--copy",
  "--exec-session",
  "--session",
  "--status",
  "--browser",
  "--browser-debug-port",
  "--no-wait",
];

test("advanced help lists every other hidden root option", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      pathToFileURL(path.join(process.cwd(), "tests/fixtures/dump-cli-options.mjs")).href,
      path.join(process.cwd(), "bin/oracle-cli.ts"),
    ],
    {
      env: { ...process.env, ORACLE_HOME_DIR: oracleHome, ORACLE_FORCE_TUI: "0", NO_COLOR: "1" },
      timeout: 15_000,
    },
  );
  const hiddenFlags = (JSON.parse(stdout) as Array<{ long?: string; hidden: boolean }>)
    .filter((option) => option.hidden && option.long)
    .map((option) => option.long as string);
  expect(hiddenFlags).toEqual(expect.arrayContaining(UNLISTED_HIDDEN_FLAGS));

  const output = await help(["--help", "--verbose"]);
  const start = output.indexOf("Advanced Options");
  expect(start).toBeGreaterThan(-1);
  // Count only flags that lead their own row, not flags mentioned in another row's description.
  const advanced = new Set(
    [...output.slice(start).matchAll(/^[ \t]+(--[a-z][a-z0-9-]*)(?=[ \t]|$)/gm)].map(
      (match) => match[1],
    ),
  );
  const missing = hiddenFlags.filter(
    (flag) => !UNLISTED_HIDDEN_FLAGS.includes(flag) && !advanced.has(flag),
  );
  expect(missing).toEqual([]);
}, 20_000);
