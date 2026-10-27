import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import type { GeminiAppRequest, GeminiAppResult } from "../../src/gemini-app/types.js";
import { runGeminiAppTool, type GeminiAppToolDeps } from "../../src/mcp/tools/geminiApp.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  launchDetachedSession,
  detachedSessionCancellationPath,
  requestDetachedSessionCancellation,
} from "../../src/cli/detachedSession.js";
import { runStoredSessionWorker } from "../../src/cli/sessionRunner.js";
import { BrowserRunCancelledError } from "../../src/oracle/errors.js";
import { runWaitTool } from "../../src/mcp/tools/wait.js";

const { runGeminiApp } = vi.hoisted(() => ({ runGeminiApp: vi.fn() }));
const { runAiStudio } = vi.hoisted(() => ({ runAiStudio: vi.fn() }));
const browserSkill = vi.hoisted(() => ({
  start: vi.fn(),
  run: vi.fn(),
  evaluate: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../../src/gemini-app/executor.js", () => ({ runGeminiApp }));
vi.mock("../../src/ai-studio/executor.js", () => ({ runAiStudio }));
vi.mock("../../src/gemini-app/browserSkill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gemini-app/browserSkill.js")>()),
  BrowserSkill: class {
    start = browserSkill.start;
    run = browserSkill.run;
    evaluate = browserSkill.evaluate;
    stop = browserSkill.stop;
  },
}));
let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-worker-"));
  setOracleHomeDirOverrideForTest(home);
});
afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});
function structured(result: Awaited<ReturnType<typeof runGeminiAppTool>>): Record<string, unknown> {
  const content: unknown = result.structuredContent;
  if (!content || typeof content !== "object" || Array.isArray(content))
    throw new Error("Missing structured content.");
  return Object.fromEntries(Object.entries(content));
}
function request(overrides: Partial<GeminiAppRequest> = {}): GeminiAppRequest {
  return {
    action: "run",
    prompt: "Worker proof",
    model: "4 Argon",
    thinking: "high",
    mode: "chat",
    outputDir: path.join(home, "generated", "worker"),
    timeoutMs: 60_000,
    ...overrides,
  };
}
function result(overrides: Partial<GeminiAppResult> = {}): GeminiAppResult {
  return {
    text: "Worker output",
    conversationUrl: "https://gemini.google.com/app/worker",
    selection: { model: "3.1 Pro", thinking: "low", mode: "chat" },
    availableModels: ["3.1 Pro"],
    availableThinking: ["low"],
    availableModes: ["chat"],
    artifacts: [],
    screenshots: [],
    ...overrides,
  };
}
async function storedRequestSession(
  value: GeminiAppRequest,
): Promise<Awaited<ReturnType<typeof sessionStore.createSession>>> {
  return sessionStore.createSession(
    { prompt: value.prompt, model: "gemini-app", mode: "browser", geminiApp: value },
    process.cwd(),
  );
}

describe("gemini_app MCP and stored worker", () => {
  test("rejects invalid input and exposes a strict MCP contract", async () => {
    const invalid = await runGeminiAppTool(
      { action: "run", prompt: "  " },
      { launchDetached: vi.fn(), runSession: vi.fn() },
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]).toMatchObject({ text: expect.stringContaining("prompt") });
    expect(await sessionStore.listSessions()).toEqual([]);
    const server = createMcpServer();
    const client = new Client({ name: "gemini-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tool = (await client.listTools()).tools.find(({ name }) => name === "gemini_app");
      expect(tool?.description).toBeTypeOf("string");
      expect(tool?.inputSchema.required).toEqual(["action"]);
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.inputSchema.properties).toMatchObject({
        model: { default: "current" },
        site: { enum: ["gemini-app", "ai-studio"], default: "gemini-app" },
        thinking: { enum: ["current", "minimal", "low", "medium", "high"] },
        mode: { enum: ["chat", "image", "video", "music", "deep-research"] },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("normalizes AI Studio site and minimal thinking while omitting the default site", async () => {
    const { resolveGeminiAppRequest } = await import("../../src/mcp/tools/geminiApp.js");
    const defaultRequest = resolveGeminiAppRequest({ action: "discovery" }).request;
    expect(defaultRequest.site).toBeUndefined();
    expect(
      resolveGeminiAppRequest({
        action: "run",
        prompt: "Local fixture only",
        site: "ai-studio",
        thinking: "minimal",
      }).request,
    ).toMatchObject({ site: "ai-studio", thinking: "minimal" });
    expect(() => resolveGeminiAppRequest({ action: "discovery", site: "other" })).toThrow();
  });

  test("dispatches AI Studio requests before legacy Gemini validation or browser setup", async () => {
    const { runGeminiApp: dispatch } = await vi.importActual<
      typeof import("../../src/gemini-app/executor.js")
    >("../../src/gemini-app/executor.js");
    runAiStudio.mockResolvedValue(
      result({ conversationUrl: "https://aistudio.google.com/prompts/new_chat" }),
    );
    const input = request({ site: "ai-studio", thinking: "minimal" });
    await expect(dispatch(input)).resolves.toMatchObject({
      conversationUrl: "https://aistudio.google.com/prompts/new_chat",
    });
    expect(runAiStudio).toHaveBeenCalledWith(input, {});
    expect(browserSkill.start).not.toHaveBeenCalled();
    runAiStudio.mockClear();
  });

  test("persists foreground response and actual artifacts through the real shared runner", async () => {
    const artifact = path.join(home, "generated", "foreground", "actual.mp3");
    runGeminiApp.mockResolvedValue(
      result({
        selection: { model: "3.1 Pro", thinking: "low", mode: "music" },
        artifacts: [{ kind: "file", path: artifact, label: "Actual music" }],
      }),
    );
    const output = await runGeminiAppTool(
      {
        action: "run",
        prompt: "Foreground proof",
        model: "4 Argon",
        mode: "music",
        outputDir: path.dirname(artifact),
      },
      {
        launchDetached: vi.fn(),
        runSession: (await import("../../src/cli/sessionRunner.js")).performSessionRun,
      },
    );
    expect(output.isError).not.toBe(true);
    const id = String(structured(output).sessionId);
    expect(runGeminiApp).toHaveBeenCalledOnce();
    const stored = await sessionStore.readSession(id);
    expect(stored?.geminiApp?.selection).toEqual({
      model: "3.1 Pro",
      thinking: "low",
      mode: "music",
    });
    expect(stored?.artifacts).toEqual([expect.objectContaining({ kind: "file", path: artifact })]);
    expect((await runWaitTool({ id, timeoutMs: 0 })).structuredContent.images).toBeUndefined();
  });

  test("hands a restored nested request to the hidden detached worker with its PID lifecycle", async () => {
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4747,
      stdin,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    let worker = Promise.resolve(0);
    const launchDetached: GeminiAppToolDeps["launchDetached"] = (options) =>
      launchDetachedSession({
        ...options,
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          stdin.on("data", () => {
            worker = runStoredSessionWorker(options.sessionId, {
              pid: 4747,
              env: { ORACLE_DETACHED_START_GATE: "1", BSK_BIN: "relative-bsk/bsk.exe" },
              loadConfig: async () => ({ config: {} }),
            });
          });
          return child;
        },
      });
    runGeminiApp.mockImplementation(async (input, context) => {
      expect(context?.signal).toBeDefined();
      return result({
        artifacts: [{ kind: "file", path: path.join(input.outputDir, "actual.txt") }],
      });
    });
    const launched = await runGeminiAppTool(
      {
        action: "run",
        prompt: "Worker proof",
        model: "4 Argon",
        thinking: "high",
        waitForCompletion: false,
      },
      { launchDetached, runSession: vi.fn() },
    );
    expect(structured(launched)).toMatchObject({ detached: true, status: "running" });
    const id = String(structured(launched).sessionId);
    const workerExit = await worker;
    expect({
      exit: workerExit,
      error: (await sessionStore.readSession(id))?.errorMessage,
      log: await sessionStore.readLog(id),
    }).toEqual({ exit: 0, error: undefined, log: expect.any(String) });
    expect(child.unref).toHaveBeenCalledOnce();
    const stored = await sessionStore.readSession(id);
    expect(runGeminiApp).toHaveBeenCalledWith(
      expect.objectContaining({ model: "4 Argon", thinking: "high" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stored?.lifecycle).toMatchObject({ detached: true, workerPid: 4747 });
    expect(stored?.options.geminiApp).toMatchObject({ model: "4 Argon", thinking: "high" });
    expect(stored?.geminiApp?.selection.model).toBe("3.1 Pro");
    expect(stored?.artifacts).toEqual([
      expect.objectContaining({ path: expect.stringContaining("actual.txt") }),
    ]);
  });

  test("preserves worker cancellation monitoring and waits for executor cleanup", async () => {
    const meta = await storedRequestSession(request());
    await sessionStore.updateSession(meta.id, {
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: `oracle session ${meta.id}`,
      },
    });
    const events: string[] = [];
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    runGeminiApp.mockImplementation(async (_input, context) => {
      context.signal?.throwIfAborted();
      notifyStarted();
      try {
        await new Promise((_resolve, reject) =>
          context.signal?.addEventListener(
            "abort",
            () => {
              events.push("abort");
              reject(context.signal.reason);
            },
            { once: true },
          ),
        );
      } finally {
        events.push("BrowserSkill session.stop complete");
      }
    });
    const worker = runStoredSessionWorker(meta.id, {
      env: { ORACLE_DETACHED_START_GATE: "1" },
      loadConfig: async () => ({ config: {} }),
    });
    await started;
    const paths = await sessionStore.getPaths(meta.id);
    await requestDetachedSessionCancellation(
      detachedSessionCancellationPath(paths.dir, process.pid),
    );
    expect(await worker).toBe(130);
    expect(events).toEqual(["abort", "BrowserSkill session.stop complete"]);
    const stored = await sessionStore.readSession(meta.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.models?.[0]?.status).toBe("cancelled");
  });

  test("waits for the real executor's BrowserSkill stop before terminal cancellation", async () => {
    const meta = await storedRequestSession(request());
    const cancellation = new AbortController();
    let releaseStop: () => void = () => undefined;
    const stop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    browserSkill.start.mockResolvedValue(undefined);
    browserSkill.run.mockResolvedValue({});
    browserSkill.evaluate.mockImplementation(async () => {
      cancellation.abort(new BrowserRunCancelledError("BrowserSkill disconnected."));
      throw cancellation.signal.reason;
    });
    let notifyStopStarted: () => void = () => undefined;
    const stopStarted = new Promise<void>((resolve) => {
      notifyStopStarted = resolve;
    });
    const boundedStopStarted = Promise.race([
      stopStarted,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for BrowserSkill.stop.")),
          4_000,
        );
        timeout.unref();
      }),
    ]);
    browserSkill.stop.mockImplementation(async () => {
      notifyStopStarted();
      await stop;
    });
    const { runGeminiApp: execute } = await vi.importActual<
      typeof import("../../src/gemini-app/executor.js")
    >("../../src/gemini-app/executor.js");
    runGeminiApp.mockImplementation(execute);
    const worker = runStoredSessionWorker(meta.id, { loadConfig: async () => ({ config: {} }) });
    await boundedStopStarted;
    expect((await sessionStore.readSession(meta.id))?.status).toBe("running");
    releaseStop();
    const exitCode = await worker;
    expect({
      exitCode,
      log: await sessionStore.readLog(meta.id),
      status: (await sessionStore.readSession(meta.id))?.status,
    }).toEqual({ exitCode: 130, log: expect.any(String), status: "cancelled" });
    expect(browserSkill.stop).toHaveBeenCalledOnce();
    expect((await sessionStore.readSession(meta.id))?.status).toBe("cancelled");
  });

  test("fails a mismatched PID handoff before invoking the executor", async () => {
    const meta = await storedRequestSession(request({ action: "discovery", prompt: undefined }));
    await sessionStore.updateSession(meta.id, {
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: 1,
        reattachCommand: `oracle session ${meta.id}`,
      },
    });
    const env: NodeJS.ProcessEnv = { ORACLE_DETACHED_START_GATE: "1" };
    expect(
      await runStoredSessionWorker(meta.id, { env, loadConfig: async () => ({ config: {} }) }),
    ).toBe(1);
    expect((await sessionStore.readSession(meta.id))?.errorMessage).toBe(
      "Detached session worker started without a matching lifecycle handoff.",
    );
    expect(runGeminiApp).not.toHaveBeenCalled();
  });

  test("persists a failed hidden-worker start gate without inline execution", async () => {
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4747,
      stdin,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const launchDetached: GeminiAppToolDeps["launchDetached"] = (options) =>
      launchDetachedSession({
        ...options,
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          stdin.on("data", () => child.emit("error", new Error("fixture worker launch failed")));
          return child;
        },
      });
    const runSession = vi.fn();
    const output = await runGeminiAppTool(
      { action: "discovery", waitForCompletion: false },
      { launchDetached, runSession },
    );
    expect(output.isError).toBe(true);
    expect(output.content[0]).toMatchObject({
      text: expect.stringContaining("fixture worker launch failed"),
    });
    const stored = await sessionStore.readSession(String(structured(output).sessionId));
    expect(stored).toMatchObject({ status: "error", errorMessage: "fixture worker launch failed" });
    expect(stored?.models?.[0]?.status).toBe("error");
    expect(runSession).not.toHaveBeenCalled();
  });
});
