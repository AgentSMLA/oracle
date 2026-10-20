import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { query, readFile } = vi.hoisted(() => ({ query: vi.fn(), readFile: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: query }),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile,
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

const pid = 12345;
const profile = path.resolve("synthetic shared profile");
const command = `chrome --user-data-dir="${profile}" --remote-debugging-port=9222`;
let alive: boolean;

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
  readFile.mockResolvedValue(String(pid));
  alive = true;
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") alive = false;
    if (!alive && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

test.each(["failed", "empty"])(
  "retries a %s process-command probe before termination",
  async (kind) => {
    if (kind === "failed") query.mockRejectedValueOnce(new Error("process query timed out"));
    else query.mockResolvedValueOnce({ stdout: "" });
    query.mockResolvedValueOnce({ stdout: command });
    query.mockImplementation(async () => {
      alive = false;
      return { stdout: "" };
    });
    const { terminateRecordedChromeForProfile } = await import("../../src/browser/profileState.js");
    await expect(terminateRecordedChromeForProfile(profile)).resolves.toBe(true);
    const commandQueries = query.mock.calls.filter(([executable]) => executable !== "taskkill.exe");
    expect(commandQueries).toHaveLength(2);
  },
);

test("does not retry or terminate a verified different process", async () => {
  query.mockResolvedValue({ stdout: "node unrelated-worker.js" });
  const { terminateRecordedChromeForProfile } = await import("../../src/browser/profileState.js");
  await expect(terminateRecordedChromeForProfile(profile)).resolves.toBe(false);
  expect(query).toHaveBeenCalledTimes(1);
  expect(process.kill).not.toHaveBeenCalledWith(pid, "SIGTERM");
});

test("leaves the process alive when both identity probes are unavailable", async () => {
  query.mockRejectedValue(new Error("process query timed out"));
  const { terminateRecordedChromeForProfile } = await import("../../src/browser/profileState.js");
  await expect(terminateRecordedChromeForProfile(profile)).resolves.toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
  expect(process.kill).not.toHaveBeenCalledWith(pid, "SIGTERM");
});

test("does not retry if the process exits after the first unavailable probe", async () => {
  query.mockImplementationOnce(async () => {
    alive = false;
    throw new Error("process exited during query");
  });
  const { terminateRecordedChromeForProfile } = await import("../../src/browser/profileState.js");
  await expect(terminateRecordedChromeForProfile(profile)).resolves.toBe(false);
  expect(query).toHaveBeenCalledTimes(1);
});
