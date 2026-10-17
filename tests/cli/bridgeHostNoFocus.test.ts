import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveBrowserNoFocus } from "../../src/browser/config.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const serveRemote = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => {}));
const spawn = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: unknown) => ({ pid: 4321, unref: vi.fn() })),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));
vi.mock("../../src/remote/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/remote/server.js")>()),
  serveRemote,
}));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "oracle-bridge-no-focus-"));
  setOracleHomeDirOverrideForTest(home);
  serveRemote.mockClear();
  spawn.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  setOracleHomeDirOverrideForTest(null);
  await rm(home, { recursive: true, force: true });
});

// A bridge host is an oracle serve host: its own flag or config decides, then the default.
test.each([
  { hostConfig: undefined, flag: undefined, expected: resolveBrowserNoFocus({}) },
  { hostConfig: false, flag: undefined, expected: false },
  { hostConfig: true, flag: undefined, expected: true },
  { hostConfig: true, flag: false, expected: false },
])(
  "bridge host passes its own no-focus setting to the server (config $hostConfig, flag $flag)",
  async ({ hostConfig, flag, expected }) => {
    if (hostConfig !== undefined) {
      await writeFile(
        path.join(home, "config.json"),
        JSON.stringify({ browser: { noFocus: hostConfig } }),
      );
    }
    const { runBridgeHost } = await import("../../src/cli/bridge/host.js");
    await runBridgeHost({
      bind: "127.0.0.1:9473",
      token: "bridge-fixture",
      writeConnection: path.join(home, "bridge-connection.json"),
      browserNoFocus: flag,
    });
    expect(serveRemote).toHaveBeenCalledOnce();
    expect(serveRemote.mock.calls[0]?.[0]).toMatchObject({ browserConfig: { noFocus: expected } });
  },
);

// --background respawns the host; the child must get the parent's explicit choice, and read its
// own config when there is none.
test.each([
  { flag: false, hostConfig: true, expected: ["--no-browser-no-focus"] },
  { flag: true, hostConfig: false, expected: ["--browser-no-focus"] },
  { flag: undefined, hostConfig: false, expected: [] },
])(
  "background bridge host passes flag $flag to the respawned host (config $hostConfig)",
  async ({ flag, hostConfig, expected }) => {
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ browser: { noFocus: hostConfig } }),
    );
    const { runBridgeHost } = await import("../../src/cli/bridge/host.js");
    await runBridgeHost({
      bind: "127.0.0.1:9473",
      token: "bridge-fixture",
      writeConnection: path.join(home, "bridge-connection.json"),
      background: true,
      browserNoFocus: flag,
    });
    expect(serveRemote).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const args = spawn.mock.calls[0]?.[1] ?? [];
    expect(args.filter((arg) => /^--(no-)?browser-no-focus$/.test(arg))).toEqual(expected);
    // Root options go before the subcommand, where the child's commander reads them.
    if (expected.length) expect(args.indexOf(expected[0])).toBeLessThan(args.indexOf("bridge"));
  },
);
