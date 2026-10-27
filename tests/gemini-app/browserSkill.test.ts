import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BrowserSkill, type BrowserSkillCommand } from "../../src/gemini-app/browserSkill.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("BrowserSkill command boundary", () => {
  it("preserves CLI JSON diagnostics when a failed command writes only stdout", async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      callback(new Error("Command failed"), '{"error":{"code":"target_not_found"}}', "");
      return {} as ReturnType<typeof execFile>;
    });
    await expect(new BrowserSkill().start()).rejects.toThrow("target_not_found");
  });

  it("passes opaque argument arrays and scopes every operation to its allocated session", async () => {
    // Given
    const calls: readonly string[][] = [];
    const recorded: string[][] = [...calls];
    const command: BrowserSkillCommand = async (_binary, args) => {
      recorded.push([...args]);
      if (args[0] === "session" && args[1] === "start")
        return JSON.stringify({ session_id: "own-session" });
      if (args[0] === "evaluate") return JSON.stringify({ ok: true, value: { answer: 42 } });
      return JSON.stringify({ ok: true });
    };
    const browser = new BrowserSkill(undefined, command);
    // When
    const sessionId = await browser.start("Work Edge");
    await browser.fill("#editor", '"; rm -rf /; $env:SECRET');
    const value = await browser.evaluate("({ answer: 42 })", z.object({ answer: z.number() }));
    await browser.download("#download", "D:/output/a file.png", 5_000);
    const stoppedId = await browser.stop();
    // Then
    expect(value).toEqual({ answer: 42 });
    expect(sessionId).toBe("own-session");
    expect(stoppedId).toBe(sessionId);
    expect(recorded[0]).toEqual([
      "session",
      "start",
      "--no-focus",
      "--browser",
      "Work Edge",
      "--json",
    ]);
    for (const call of recorded.slice(1, -1))
      expect(call.slice(-3)).toEqual(["--session", "own-session", "--json"]);
    expect(recorded[1]).toContain('"; rm -rf /; $env:SECRET');
    expect(recorded.find((call) => call[0] === "download")).toEqual([
      "download",
      "--selector",
      "#download",
      "--out",
      "D:/output/a file.png",
      "--timeout",
      "5000ms",
      "--session",
      "own-session",
      "--json",
    ]);
    expect(recorded.at(-1)).toEqual(["session", "stop", "own-session", "--json"]);
  });

  it("rejects malformed JSON rather than scraping an apparent result", async () => {
    // Given
    const browser = new BrowserSkill(undefined, async () => "banner\n{}");
    // When / Then
    await expect(browser.start()).rejects.toThrow("BrowserSkill returned invalid JSON.");
  });

  it("rejects an evaluation refusal even when the CLI exits successfully", async () => {
    // Given
    const command: BrowserSkillCommand = async (_binary, args) =>
      JSON.stringify(
        args[0] === "session" ? { session_id: "owned" } : { ok: false, error: "permission_denied" },
      );
    const browser = new BrowserSkill(undefined, command);
    await browser.start();
    // When / Then
    await expect(browser.evaluate("42", z.number())).rejects.toThrow("permission_denied");
  });

  it("can stop a late allocation after cancellation without the cancelled signal", async () => {
    // Given
    const controller = new AbortController();
    const options: Array<{ readonly signal?: AbortSignal }> = [];
    const command: BrowserSkillCommand = async (_binary, args, option) => {
      options.push(option);
      if (args[1] === "start") {
        controller.abort();
        return JSON.stringify({ session_id: "late-owned" });
      }
      return JSON.stringify({ ok: true });
    };
    const browser = new BrowserSkill(controller.signal, command);
    // When
    await expect(browser.start()).rejects.toThrow();
    await browser.stop();
    // Then
    expect(options).toHaveLength(2);
    expect(options.every((option) => option.signal === undefined)).toBe(true);
  });
});
