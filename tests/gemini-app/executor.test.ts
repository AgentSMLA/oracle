import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemsSchema } from "../../src/gemini-app/dom.js";
import { runGeminiApp, verifyMediaArtifact } from "../../src/gemini-app/executor.js";
import type { GeminiAppMode, GeminiAppRequest } from "../../src/gemini-app/types.js";
import { GeminiAppError } from "../../src/gemini-app/browserSkill.js";

const cli = vi.hoisted(() => ({
  execute: (_args: readonly string[], _signal?: AbortSignal): Promise<string> =>
    Promise.reject(new Error("Fixture not initialized")),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    options: { signal?: AbortSignal },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cli.execute(args, options.signal).then(
      (stdout) => callback(null, stdout, ""),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)), "", ""),
    );
  },
}));

type Item = ReturnType<typeof itemsSchema.parse>[number];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3l8AAAAASUVORK5CYII=",
  "base64",
);
let root: string;
let calls: string[][];
let models: Item[];
let thinking: Item[];
let tools: Item[];
let ignoreModelClick: boolean;
let ignoreThinkingClick: boolean;
let resetThinkingOnModelClick: boolean;
let orphanChip: boolean;
let stopError: boolean;
let accepted: boolean;
let turnFailure: boolean;
let downloadBytes: Buffer;
let researchApproved: boolean;
let onSubmit: (() => void) | undefined;

function arg(args: readonly string[], flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  if (!value) throw new Error(`Missing fixture flag ${flag}`);
  return value;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-gemini-executor-"));
  const fixtures: unknown = JSON.parse(
    await fs.readFile(new URL("./fixtures/controls.json", import.meta.url), "utf8"),
  );
  const controls = await import("zod").then(({ z }) =>
    z.object({ models: itemsSchema, thinking: itemsSchema, tools: itemsSchema }).parse(fixtures),
  );
  models = controls.models;
  thinking = controls.thinking;
  tools = controls.tools;
  calls = [];
  ignoreModelClick = false;
  ignoreThinkingClick = false;
  resetThinkingOnModelClick = false;
  orphanChip = false;
  stopError = false;
  accepted = true;
  turnFailure = false;
  researchApproved = false;
  downloadBytes = png;
  onSubmit = undefined;
  cli.execute = async (args, signal) => {
    calls.push([...args]);
    signal?.throwIfAborted();
    const command = args[0];
    if (command === "session" && args[1] === "stop" && stopError)
      throw new Error("STOP_FAILURE_SENTINEL");
    if (command === "session")
      return JSON.stringify(args[1] === "start" ? { session_id: "owned-fixture" } : { ok: true });
    if (command === "screenshot") await fs.writeFile(arg(args, "--out"), png);
    if (command === "download") await fs.writeFile(arg(args, "--out"), downloadBytes);
    if (command === "click") {
      const selector = arg(args, "--selector");
      const targetModel = models.find((item) => item.selector === selector);
      if (targetModel && !ignoreModelClick) {
        models = models.map((item) => ({ ...item, selected: item === targetModel }));
        if (resetThinkingOnModelClick)
          thinking = thinking.map((item) => ({ ...item, selected: item.label === "高" }));
      }
      const effort = thinking.find((item) => item.selector === selector);
      if (effort && !ignoreThinkingClick)
        thinking = thinking.map((item) => ({ ...item, selected: item === effort }));
      const tool = tools.find((item) => item.selector === selector);
      if (tool)
        tools = tools.map((item) => ({
          ...item,
          selected: item === tool ? !item.selected : false,
        }));
      if (selector === "#approve-plan") researchApproved = true;
    }
    if (command === "press" && args[1] === "Enter" && args.includes("#native-send")) onSubmit?.();
    if (command === "evaluate") {
      const expression = args[1] ?? "";
      const operationMatch = expression.match(/\)\((\{.*\}), \d+\)$/s);
      let value: unknown = true;
      if (operationMatch?.[1]) {
        const operation: unknown = JSON.parse(operationMatch[1]);
        const { z } = await import("zod");
        const parsed = z
          .object({
            kind: z.string(),
            approved: z.boolean().optional(),
            mode: z.string().optional(),
          })
          .parse(operation);
        switch (parsed.kind) {
          case "models":
            value = models;
            break;
          case "thinking":
            value = thinking;
            break;
          case "tools":
            value = tools;
            break;
          case "send":
            value = { selector: "#native-send", modelButtonText: "Argon" };
            break;
          case "accepted":
            if (!accepted) throw new Error("ACCEPTANCE_UNVERIFIED_SENTINEL");
            value = true;
            break;
          case "capture-image":
            value = {
              dataUrl: `data:image/png;base64,${downloadBytes.toString("base64")}`,
              mimeType: "image/png",
              width: 1024,
              height: 572,
            };
            break;
          case "capture-video":
            value = {
              dataUrl: `data:video/mp4;base64,${downloadBytes.toString("base64")}`,
              mimeType: "video/mp4",
              byteLength: downloadBytes.length,
            };
            break;
          case "capture-music":
            value = {
              dataUrl: `data:audio/wav;base64,${downloadBytes.toString("base64")}`,
              mimeType: "audio/wav",
              byteLength: downloadBytes.length,
            };
            break;
          case "turn":
            value = {
              phase: turnFailure
                ? "failed"
                : parsed.mode === "deep-research" && !parsed.approved
                  ? "plan"
                  : "complete",
              failure: turnFailure ? "QUOTA_FAILURE_SENTINEL" : undefined,
              text:
                parsed.mode === "deep-research" && parsed.approved ? "REPORT_OK" : "FRESH_REPLY_OK",
              url: "https://gemini.google.com/app/fresh-fixture",
              control:
                parsed.mode === "deep-research" && !parsed.approved
                  ? "#approve-plan"
                  : parsed.mode !== "chat"
                    ? "#download-fresh"
                    : null,
              citations:
                parsed.mode === "deep-research" && parsed.approved && researchApproved
                  ? [{ title: "Official source", url: "https://support.google.com/gemini/" }]
                  : [],
            };
            break;
          default:
            value = true;
        }
      } else if (expression === "location.href") value = "https://gemini.google.com/app";
      else if (
        expression.startsWith(
          "Array.from(document.querySelectorAll('.toolbox-drawer-item-deselect-button",
        )
      ) {
        const chipLabels: Readonly<Record<string, string>> = {
          建立圖像: "取消選取「圖片」",
          建立影片: "取消選取「影片」",
          創作音樂: "取消選取「音樂」",
          "Deep Research": "取消選取「Deep Research」",
          Canvas: "Deselect Canvas",
        };
        value = tools
          .filter((item) => item.selected)
          .map((item) => chipLabels[item.label] ?? item.label);
        if (orphanChip) value = ["Deselect Canvas"];
      }
      return JSON.stringify({ ok: true, value });
    }
    return JSON.stringify({ ok: true });
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function request(overrides: Partial<GeminiAppRequest> = {}): GeminiAppRequest {
  return {
    action: "run",
    model: "current",
    thinking: "current",
    mode: "chat",
    prompt: "PROMPT_SENTINEL",
    outputDir: root,
    timeoutMs: 20_000,
    ...overrides,
  };
}

const submitted = (): boolean =>
  calls.some((args) => args[0] === "press" && args[1] === "Enter" && args.includes("#native-send"));
const stopped = (): boolean =>
  calls.some((args) => args[0] === "session" && args[1] === "stop" && args[2] === "owned-fixture");

describe("Gemini App executor through command fixtures", () => {
  it("discovers dynamic exact labels without filling or submitting", async () => {
    // Given / When
    const result = await runGeminiApp(request({ action: "discovery", prompt: undefined }));
    // Then
    expect(result.availableModels).toContain("Future Exact Label");
    expect(result.selection).toEqual({ model: "4 Argon", thinking: "low", mode: "chat" });
    expect(result.screenshots).toHaveLength(1);
    expect(calls.some((args) => args[0] === "fill")).toBe(false);
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("verifies reopened exact model and effort before submitting", async () => {
    // Given / When
    const result = await runGeminiApp(request({ model: "Future Exact Label", thinking: "high" }));
    // Then
    expect(result.selection).toEqual({
      model: "Future Exact Label",
      thinking: "high",
      mode: "chat",
    });
    expect(result.text).toBe("FRESH_REPLY_OK");
    expect(submitted()).toBe(true);
    expect(stopped()).toBe(true);
  });

  it("never submits when a model click did not change actual selection", async () => {
    // Given
    ignoreModelClick = true;
    // When / Then
    await expect(runGeminiApp(request({ model: "3.8 Flash" }))).rejects.toThrow(
      "selection mismatch",
    );
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("never submits when an effort click did not change actual selection", async () => {
    // Given
    ignoreThinkingClick = true;
    // When / Then
    await expect(runGeminiApp(request({ thinking: "high" }))).rejects.toThrow("selection mismatch");
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("preserves the initially observed current effort across a model change", async () => {
    // Given
    resetThinkingOnModelClick = true;
    // When
    const result = await runGeminiApp(
      request({ model: "Future Exact Label", thinking: "current" }),
    );
    // Then
    expect(result.selection.thinking).toBe("low");
    expect(submitted()).toBe(true);
  });

  it("rejects a stale private model alias before submission", async () => {
    // Given / When / Then
    await expect(runGeminiApp(request({ model: "gemini-3-pro" }))).rejects.toThrow(
      "model unavailable",
    );
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("deselects Canvas so plain chat does not inherit an active tool", async () => {
    // Given
    tools = tools.map((item) => ({ ...item, selected: item.label === "Canvas" }));
    // When
    const result = await runGeminiApp(request());
    // Then
    expect(result.selection.mode).toBe("chat");
    expect(tools.every((item) => !item.selected)).toBe(true);
    expect(calls.some((args) => args.includes("#canvas"))).toBe(true);
  });

  it("rejects an active composer chip even if the tools menu claims plain chat", async () => {
    // Given
    orphanChip = true;
    // When / Then
    await expect(runGeminiApp(request())).rejects.toThrow("active composer tool");
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("fails closed on a disabled requested tool", async () => {
    // Given
    tools = tools.map((item) => ({ ...item, disabled: item.label === "建立影片" }));
    // When / Then
    await expect(runGeminiApp(request({ mode: "video" }))).rejects.toThrow("tool unavailable");
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });

  it("approves the research plan and emits only the finished cited report", async () => {
    // Given / When
    const result = await runGeminiApp(request({ mode: "deep-research" }));
    // Then
    expect(researchApproved).toBe(true);
    expect(result.text).toBe("REPORT_OK");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe("deep-research-report");
    const report = await fs.readFile(result.artifacts[0]?.path ?? "", "utf8");
    expect(report).toContain("https://support.google.com/gemini/");
    expect(result.screenshots).toHaveLength(3);
    expect(stopped()).toBe(true);
  });

  it("captures decoded image pixels without the host's broken download trigger", async () => {
    // Given / When
    const result = await runGeminiApp(request({ mode: "image" }));
    // Then
    expect(calls.filter((args) => args[0] === "download")).toHaveLength(0);
    expect(
      calls.filter((args) => args[0] === "evaluate" && args[1]?.includes('"kind":"capture-image"')),
    ).toHaveLength(1);
    expect(calls.some((args) => args[0] === "click" && args.includes("#download-fresh"))).toBe(
      false,
    );
    expect(result.artifacts[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      sizeBytes: png.length,
      validation: { ok: true },
    });
    expect(await fs.readFile(result.artifacts[0]?.path ?? "")).toEqual(png);
  });

  it("persists authenticated-page video bytes only after their actual MP4 container validates", async () => {
    // Given: a small synthetic ISO BMFF container, not a playback fixture.
    downloadBytes = Buffer.from(
      "000000186674797069736f6d0000020069736f6d6d703432000000086d6f6f76000000106d6461740000000000000000",
      "hex",
    );
    // When
    const result = await runGeminiApp(request({ mode: "video" }));
    // Then
    expect(calls.filter((args) => args[0] === "download")).toHaveLength(0);
    expect(
      calls.filter((args) => args[0] === "evaluate" && args[1]?.includes('"kind":"capture-video"')),
    ).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "file",
      mimeType: "video/mp4",
      sizeBytes: downloadBytes.length,
    });
    expect(await fs.readFile(result.artifacts[0]?.path ?? "")).toEqual(downloadBytes);
  });

  it("rejects HTML masquerading as downloaded image and still stops its session", async () => {
    // Given
    downloadBytes = Buffer.from("<html>provider quota</html>");
    // When / Then
    await expect(runGeminiApp(request({ mode: "image" }))).rejects.toThrow(
      "invalid or mismatched media bytes",
    );
    expect(stopped()).toBe(true);
  });

  it("stops only its own session when cancellation arrives after submission", async () => {
    // Given
    const controller = new AbortController();
    onSubmit = () => controller.abort();
    // When / Then
    await expect(runGeminiApp(request(), { signal: controller.signal })).rejects.toThrow();
    expect(submitted()).toBe(true);
    expect(stopped()).toBe(true);
    expect(calls.filter((args) => args[0] === "session" && args[1] === "stop")).toHaveLength(1);
  });

  it("activates the enabled send button once and never retries ambiguous acceptance", async () => {
    // Given
    accepted = false;
    // When / Then
    await expect(runGeminiApp(request())).rejects.toThrow("ACCEPTANCE_UNVERIFIED_SENTINEL");
    expect(
      calls.filter((args) => args[0] === "press" && args.includes("#native-send")),
    ).toHaveLength(1);
    expect(calls.some((args) => args[0] === "click" && args.includes("#native-send"))).toBe(false);
    expect(calls.some((args) => args[0] === "evaluate" && args[1]?.includes('"kind":"turn"'))).toBe(
      false,
    );
    expect(stopped()).toBe(true);
  });

  it("fails closed and saves actual reply plus screenshots when quota or fallback is observed", async () => {
    // Given
    turnFailure = true;
    let evidencePath: string | undefined;
    // When
    try {
      await runGeminiApp(request({ mode: "deep-research" }));
    } catch (error) {
      if (!(error instanceof GeminiAppError)) throw error;
      evidencePath = error.evidencePath;
    }
    // Then
    expect(evidencePath).toBeDefined();
    const evidence: unknown = JSON.parse(await fs.readFile(evidencePath ?? "", "utf8"));
    expect(evidence).toMatchObject({
      actualReply: "FRESH_REPLY_OK",
      automaticRetryPerformed: false,
      submissionMayHaveBeenAccepted: true,
      screenshots: expect.arrayContaining([expect.stringContaining("-failure.png")]),
    });
    expect(
      calls.filter((args) => args[0] === "press" && args.includes("#native-send")),
    ).toHaveLength(1);
    expect(stopped()).toBe(true);
  });

  it("does not allocate any browser resources for an already cancelled request", async () => {
    // Given
    const controller = new AbortController();
    controller.abort();
    // When / Then
    await expect(runGeminiApp(request(), { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("preserves both execution and cleanup failures without claiming cleanup succeeded", async () => {
    // Given
    stopError = true;
    // When / Then
    await expect(
      runGeminiApp(request({ model: "UNAVAILABLE_MODEL_SENTINEL" })),
    ).rejects.toMatchObject({
      errors: [{ code: "selection" }, { code: "browser" }],
    });
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });
});

describe("local media artifact validation", () => {
  it("validates a complete PCM WAV container and persists its actual audio type", async () => {
    // Given
    const bytes = Buffer.alloc(60);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(52, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8_000, 24);
    bytes.writeUInt32LE(16_000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(16, 40);
    const file = path.join(root, "music.download");
    await fs.writeFile(file, bytes);
    // When
    const artifact = await verifyMediaArtifact(file, "music");
    // Then
    expect(artifact).toMatchObject({
      kind: "file",
      mimeType: "audio/wav",
      sizeBytes: 60,
      transfer: { status: "completed" },
    });
    expect(await fs.readFile(artifact.path)).toEqual(bytes);
  });

  it.each<GeminiAppMode>(["video", "music"])("rejects an image returned for %s", async (mode) => {
    // Given
    const file = path.join(root, "wrong.download");
    await fs.writeFile(file, png);
    // When / Then
    await expect(verifyMediaArtifact(file, mode)).rejects.toThrow("mismatched");
  });

  it("rejects a truncated container", async () => {
    // Given
    const file = path.join(root, "truncated.download");
    await fs.writeFile(file, png.subarray(0, 28));
    // When / Then
    await expect(verifyMediaArtifact(file, "image")).rejects.toThrow("invalid");
  });
});
