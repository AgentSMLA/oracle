import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import type { GeminiAppRequest, GeminiAppResult } from "../../src/gemini-app/types.js";
import { performSessionRun } from "../../src/cli/sessionRunner.js";
import { buildRunOptionsFromMetadata } from "../../src/cli/sessionRunner.js";
import { BrowserRunCancelledError } from "../../src/oracle/errors.js";
import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import { runOracle } from "../../src/oracle.js";

const { runGeminiApp } = vi.hoisted(() => ({ runGeminiApp: vi.fn() }));
vi.mock("../../src/gemini-app/executor.js", () => ({ runGeminiApp }));
vi.mock("../../src/browser/sessionRunner.js", () => ({
  runBrowserSessionExecution: vi.fn(),
  ensureSessionArtifacts: vi.fn(),
}));
vi.mock("../../src/oracle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/oracle.js")>()),
  runOracle: vi.fn(),
}));

const request: GeminiAppRequest = {
  action: "run",
  prompt: "Reply with durable output",
  model: "4 Argon",
  thinking: "high",
  mode: "chat",
  outputDir: "OUTPUT",
  timeoutMs: 60_000,
  browser: "edge",
};
const result: GeminiAppResult = {
  text: "Durable output",
  conversationUrl: "https://gemini.google.com/app/answer",
  selection: { model: "3.1 Pro", thinking: "low", mode: "chat" },
  availableModels: ["3.1 Pro", "4 Argon"],
  availableThinking: ["low", "high"],
  availableModes: ["chat"],
  artifacts: [
    {
      kind: "image",
      path: "OUTPUT/answer.png",
      validation: { type: "generic", ok: true },
      transfer: { status: "completed", bytes: 12 },
      origin: { mode: "local" },
    },
  ],
  screenshots: ["OUTPUT/complete.png"],
};
let home: string;
let outputDir: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-session-"));
  outputDir = path.join(home, "generated", "artifacts");
  setOracleHomeDirOverrideForTest(home);
});
afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function createRequestSession(): Promise<
  Awaited<ReturnType<typeof sessionStore.createSession>>
> {
  return sessionStore.createSession(
    {
      prompt: request.prompt,
      model: "gemini-app",
      mode: "browser",
      geminiApp: { ...request, outputDir },
      waitPreference: false,
    },
    process.cwd(),
  );
}

describe("Gemini App durable session", () => {
  test("round-trips the exact nested request into worker run options", async () => {
    const meta = await createRequestSession();
    const stored = await sessionStore.readSession(meta.id);
    expect(stored?.options.geminiApp).toEqual({ ...request, outputDir });
    expect(buildRunOptionsFromMetadata(stored!).geminiApp).toEqual({ ...request, outputDir });
    expect(buildRunOptionsFromMetadata(stored!).model).toBe("gemini-app");
  });

  test("uses the dedicated executor instead of legacy browser/API model execution", async () => {
    const meta = await createRequestSession();
    vi.mocked(runBrowserSessionExecution).mockRejectedValue(
      new Error("legacy browser executor called"),
    );
    vi.mocked(runOracle).mockRejectedValue(new Error("legacy API executor called"));
    runGeminiApp.mockResolvedValue({
      ...result,
      artifacts: [{ ...result.artifacts[0], path: path.join(outputDir, "answer.png") }],
    });
    await performSessionRun({
      sessionMeta: meta,
      runOptions: buildRunOptionsFromMetadata(meta),
      mode: "browser",
      cwd: process.cwd(),
      log: () => undefined,
      write: () => true,
      version: "test",
      muteStdout: true,
    });
    expect(runGeminiApp).toHaveBeenCalledWith(
      { ...request, outputDir },
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(runOracle).not.toHaveBeenCalled();
    const stored = await sessionStore.readSession(meta.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.geminiApp?.selection).toEqual(result.selection);
    expect(stored?.artifacts?.[0]?.path).toBe(path.join(outputDir, "answer.png"));
  });

  test("persists cancellation and aborts the BrowserSkill execution", async () => {
    const meta = await createRequestSession();
    const cancellation = new AbortController();
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    runGeminiApp.mockImplementation(async (_request, context) => {
      context.signal?.addEventListener("abort", () => notifyStarted(), { once: true });
      notifyStarted();
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(context.signal.reason), {
          once: true,
        });
      });
    });
    const running = performSessionRun({
      sessionMeta: meta,
      runOptions: buildRunOptionsFromMetadata(meta),
      mode: "browser",
      cwd: process.cwd(),
      log: () => undefined,
      write: () => true,
      version: "test",
      muteStdout: true,
      signal: cancellation.signal,
    });
    const rejection = expect(running).rejects.toThrow(BrowserRunCancelledError);
    await started;
    cancellation.abort(new BrowserRunCancelledError("Detached cancellation marker received."));
    await rejection;
    const stored = await sessionStore.readSession(meta.id);
    expect(stored).toMatchObject({ status: "cancelled", response: { status: "cancelled" } });
    expect(stored?.errorMessage).toBeUndefined();
    expect(stored?.models?.[0]?.status).toBe("cancelled");
  });
});
