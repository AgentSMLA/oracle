import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execute = promisify(execFile);

describe("install-omo-mcp", () => {
  let root: string;
  let home: string;
  let script: string;
  let entrypoint: string;
  let configPath: string;
  let install: (options: { home: string; dryRun?: boolean }) => Promise<{
    changed: boolean;
    configPath: string;
    entrypoint: string;
    backup: string | null;
  }>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-omo-installer-"));
    home = path.join(root, "home with spaces");
    script = path.join(root, "fork with spaces", "scripts", "install-omo-mcp.mjs");
    entrypoint = path.join(root, "fork with spaces", "dist", "bin", "oracle-mcp.js");
    configPath = path.join(home, ".omo", "agent", "mcp.json");
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.copyFile(new URL("../scripts/install-omo-mcp.mjs", import.meta.url), script);
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(entrypoint, "");
    install = (await import(pathToFileURL(script).href)).installOmoMcp;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(value: unknown) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify(value)}\n`;
    await fs.writeFile(configPath, original);
    return original;
  }

  it("registers the relocated fork through the CLI in a fresh home", async () => {
    const { stdout, stderr } = await execute(process.execPath, [script, "--home", home]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ changed: true, configPath, entrypoint, backup: null });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      mcpServers: {
        oracle: {
          type: "stdio",
          command: process.execPath,
          args: [entrypoint],
          env: { ORACLE_ENGINE: "browser" },
        },
      },
    });
    await expect(fs.stat(path.join(home, ".oracle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated fields and oracle extras, backing up exact original bytes", async () => {
    const existing = {
      enabled: true,
      mcpServers: {
        other: { type: "http", url: "https://example.invalid", extra: 3 },
        oracle: {
          type: "http",
          command: "old",
          args: ["old"],
          timeout: 45,
          env: { TOKEN: "not-for-output", ORACLE_ENGINE: "api" },
        },
      },
    };
    const original = await seed(existing);
    const result = await install({ home });
    expect(result.changed).toBe(true);
    expect(result.backup).not.toBeNull();
    if (result.backup === null) throw new Error("Expected an existing-config backup");
    expect(await fs.readFile(result.backup, "utf8")).toBe(original);
    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(updated.enabled).toBe(true);
    expect(updated.mcpServers.other).toEqual(existing.mcpServers.other);
    expect(updated.mcpServers.oracle).toEqual({
      ...existing.mcpServers.oracle,
      type: "stdio",
      command: process.execPath,
      args: [entrypoint],
      env: { TOKEN: "not-for-output", ORACLE_ENGINE: "browser" },
    });
    expect(JSON.stringify(result)).not.toContain("not-for-output");
    expect((await fs.readdir(path.dirname(configPath))).sort()).toEqual(
      ["mcp.json", path.basename(result.backup)].sort(),
    );
  });

  it("is idempotent without rewriting formatting or making another backup", async () => {
    await install({ home });
    const compact = JSON.stringify(JSON.parse(await fs.readFile(configPath, "utf8")));
    await fs.writeFile(configPath, compact);
    const before = await fs.stat(configPath);
    expect(await install({ home })).toEqual({
      changed: false,
      configPath,
      entrypoint,
      backup: null,
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(compact);
    expect((await fs.stat(configPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(path.dirname(configPath))).toEqual(["mcp.json"]);
  });

  it("dry-runs fresh and existing homes without mutation or secret output", async () => {
    const { stdout } = await execute(process.execPath, [script, "--home", home, "--dry-run"]);
    expect(JSON.parse(stdout)).toEqual({ changed: true, configPath, entrypoint, backup: null });
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    const original = await seed({ mcpServers: { oracle: { env: { TOKEN: "private" } } } });
    const result = await install({ home, dryRun: true });
    expect(result.changed).toBe(true);
    expect(result.backup).toBeNull();
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readdir(path.dirname(configPath))).toEqual(["mcp.json"]);
  });

  it("rejects malformed JSON before writes and does not echo its contents", async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = '{"TOKEN":"private", broken}';
    await fs.writeFile(configPath, original);
    await expect(install({ home })).rejects.toThrow("Invalid JSON");
    const result = await execute(process.execPath, [script, "--home", home]).catch(
      (error) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("private");
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readdir(path.dirname(configPath))).toEqual(["mcp.json"]);
  });

  it.each([
    null,
    [],
    { mcpServers: [] },
    { mcpServers: { oracle: null } },
    { mcpServers: { oracle: { env: [] } } },
  ])("rejects invalid object shape without changing config: %j", async (value) => {
    const original = await seed(value);
    await expect(install({ home })).rejects.toThrow("Invalid object shape");
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readdir(path.dirname(configPath))).toEqual(["mcp.json"]);
  });

  it("requires the build before creating or changing any config", async () => {
    await fs.unlink(entrypoint);
    await expect(install({ home })).rejects.toThrow();
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    const original = await seed({ keep: true });
    await expect(install({ home })).rejects.toThrow();
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readdir(path.dirname(configPath))).toEqual(["mcp.json"]);
  });
});
