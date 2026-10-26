import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const forkRoot = fileURLToPath(new URL("../", import.meta.url));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function installOmoMcp({ home = homedir(), dryRun = false } = {}) {
  const entrypoint = path.join(forkRoot, "dist", "bin", "oracle-mcp.js");
  if (!(await stat(entrypoint)).isFile()) {
    throw new Error(`Build Oracle before installing MCP: ${entrypoint}`);
  }
  const configPath = path.resolve(home, ".omo", "agent", "mcp.json");
  let original;
  try {
    original = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let config = {};
  if (original !== undefined) {
    try {
      config = JSON.parse(original);
    } catch {
      throw new Error(`Invalid JSON in MCP config: ${configPath}`);
    }
  }
  if (
    !object(config) ||
    (config.mcpServers !== undefined && !object(config.mcpServers)) ||
    (config.mcpServers !== undefined &&
      Object.values(config.mcpServers).some((server) => !object(server))) ||
    (config.mcpServers?.oracle?.env !== undefined && !object(config.mcpServers.oracle.env))
  ) {
    throw new Error(`Invalid object shape in MCP config: ${configPath}`);
  }
  const oracle = config.mcpServers?.oracle ?? {};
  const next = {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      oracle: {
        ...oracle,
        type: "stdio",
        command: process.execPath,
        args: [entrypoint],
        env: { ...oracle.env, ORACLE_ENGINE: "browser" },
      },
    },
  };
  const changed = !isDeepStrictEqual(config, next);
  let backup = null;
  if (changed && !dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      if (original !== undefined) {
        backup = `${configPath}.${randomUUID()}.bak`;
        await copyFile(configPath, backup, constants.COPYFILE_EXCL);
      }
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return { changed, configPath, entrypoint, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { home: { type: "string" }, "dry-run": { type: "boolean", default: false } },
    });
    console.log(
      JSON.stringify(await installOmoMcp({ home: values.home, dryRun: values["dry-run"] })),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
