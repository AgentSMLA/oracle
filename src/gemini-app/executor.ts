import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SessionArtifact } from "../sessionStore.js";
import { BrowserSkill, GeminiAppError } from "./browserSkill.js";
import {
  domExpression,
  itemsSchema,
  mediaCaptureExpression,
  mediaCaptureSchema,
  sendSchema,
  turnSchema,
} from "./dom.js";
import type {
  GeminiAppExecutionContext,
  GeminiAppMode,
  GeminiAppRequest,
  GeminiAppResult,
} from "./types.js";
import { runAiStudio } from "../ai-studio/executor.js";

const MODEL_BUTTON = '[data-test-id="bard-mode-menu-button"]';
const THINKING_BUTTON = 'gem-menu-item[value="thinking_level"]';
const TOOL_BUTTON =
  'button.toolbox-drawer-button, button[aria-label="上傳與工具"], button[aria-label="Tools"]';
const EDITOR = 'rich-textarea .ql-editor[contenteditable="true"]';
const toolModes: Readonly<Record<string, GeminiAppMode>> = {
  建立圖像: "image",
  "Create image": "image",
  "Create images": "image",
  建立影片: "video",
  "Create video": "video",
  "Create videos": "video",
  創作音樂: "music",
  "Create music": "music",
  "Deep Research": "deep-research",
};
const thinkingLabels: Readonly<Record<string, string>> = {
  低: "low",
  中等: "medium",
  高: "high",
  Low: "low",
  Medium: "medium",
  High: "high",
  low: "low",
  medium: "medium",
  high: "high",
};
type Item = z.infer<typeof itemsSchema>[number];

function onlySelected(items: readonly Item[], label: string): Item {
  const selected = items.filter((item) => item.selected);
  if (selected.length !== 1 || !selected[0]) {
    throw new GeminiAppError("selection", `Gemini ${label} selection is not uniquely observable.`);
  }
  return selected[0];
}

function mediaType(
  bytes: Buffer,
): { mime: string; extension: string; mode: "image" | "video" | "music" } | null {
  if (bytes.length < 16) return null;
  const ascii = (start: number, end: number): string => bytes.toString("ascii", start, end);
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length >= 45 &&
    ascii(12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 &&
    ascii(bytes.length - 8, bytes.length - 4) === "IEND"
  ) {
    return { mime: "image/png", extension: "png", mode: "image" };
  }
  if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    return { mime: "image/jpeg", extension: "jpg", mode: "image" };
  }
  if (ascii(0, 4) === "RIFF" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    if (ascii(8, 12) === "WEBP" && /^VP8[ LX]$/.test(ascii(12, 16)))
      return { mime: "image/webp", extension: "webp", mode: "image" };
    if (
      ascii(8, 12) === "WAVE" &&
      bytes.includes(Buffer.from("fmt ")) &&
      bytes.includes(Buffer.from("data")) &&
      bytes.length > 44
    ) {
      return { mime: "audio/wav", extension: "wav", mode: "music" };
    }
  }
  if (
    ascii(4, 8) === "ftyp" &&
    bytes.readUInt32BE(0) >= 16 &&
    bytes.readUInt32BE(0) < bytes.length &&
    bytes.includes(Buffer.from("moov")) &&
    bytes.includes(Buffer.from("mdat"))
  ) {
    if (ascii(8, 12) === "M4A ") return { mime: "audio/mp4", extension: "m4a", mode: "music" };
    return { mime: "video/mp4", extension: "mp4", mode: "video" };
  }
  if (
    bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    bytes.includes(Buffer.from("webm")) &&
    bytes.includes(Buffer.from([31, 67, 182, 117]))
  ) {
    return { mime: "video/webm", extension: "webm", mode: "video" };
  }
  if (
    ascii(0, 4) === "OggS" &&
    (bytes.includes(Buffer.from("OpusHead")) || bytes.includes(Buffer.from("vorbis")))
  ) {
    return { mime: "audio/ogg", extension: "ogg", mode: "music" };
  }
  let mp3Start = 0;
  if (ascii(0, 3) === "ID3")
    mp3Start =
      10 +
      ((bytes[6] & 127) * 2 ** 21 +
        (bytes[7] & 127) * 2 ** 14 +
        (bytes[8] & 127) * 128 +
        (bytes[9] & 127));
  if (
    bytes.length > mp3Start + 4 &&
    bytes[mp3Start] === 255 &&
    (bytes[mp3Start + 1] & 224) === 224 &&
    (bytes[mp3Start + 2] & 240) !== 0 &&
    (bytes[mp3Start + 2] & 240) !== 240
  ) {
    return { mime: "audio/mpeg", extension: "mp3", mode: "music" };
  }
  return null;
}

/** Only a regular, nonempty local file with matching container bytes becomes an artifact. */
export async function verifyMediaArtifact(
  file: string,
  mode: GeminiAppMode,
): Promise<SessionArtifact> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) {
    throw new GeminiAppError("artifact", "Gemini download is not a nonempty regular file.");
  }
  const bytes = await fs.readFile(file);
  const type = mediaType(bytes);
  if (!type || type.mode !== mode) {
    throw new GeminiAppError(
      "artifact",
      `Gemini ${mode} download has invalid or mismatched media bytes.`,
    );
  }
  const target = `${file}.${type.extension}`;
  await fs.rename(file, target);
  return {
    kind: mode === "image" ? "image" : "file",
    path: target,
    label: `Gemini ${mode}`,
    mimeType: type.mime,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validation: { type: "generic", ok: true },
    transfer: { status: "completed", bytes: bytes.length },
    origin: { mode: "local" },
  };
}

/** Execute against the existing signed-in BrowserSkill connection, with no cookie access. */
export async function runGeminiApp(
  request: GeminiAppRequest,
  context: GeminiAppExecutionContext = {},
): Promise<GeminiAppResult> {
  if (request.site === "ai-studio") return runAiStudio(request, context);
  context.signal?.throwIfAborted();
  if (!path.isAbsolute(request.outputDir))
    throw new GeminiAppError("artifact", "Gemini outputDir must be absolute.");
  if (request.action === "run" && !request.prompt?.trim())
    throw new GeminiAppError("unavailable", "Gemini run requires a nonempty prompt.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
    throw new GeminiAppError("timeout", "Gemini timeoutMs must be a positive integer.");
  await fs.mkdir(request.outputDir, { recursive: true });
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(request.timeoutMs)])
    : AbortSignal.timeout(request.timeoutMs);
  const browser = new BrowserSkill(signal);
  const deadline = Date.now() + request.timeoutMs;
  const remaining = (): number => {
    signal.throwIfAborted();
    const budget = deadline - Date.now();
    if (budget <= 0) throw new GeminiAppError("timeout", "Gemini App execution deadline expired.");
    return budget;
  };
  const token = randomUUID();
  const screenshots: string[] = [];
  const screenshot = async (label: string): Promise<void> => {
    const output = path.join(request.outputDir, `${token}-${label}.png`);
    await browser.screenshot(output);
    const bytes = await fs.readFile(output);
    if (mediaType(bytes)?.mime !== "image/png")
      throw new GeminiAppError("artifact", "BrowserSkill did not save a valid PNG screenshot.");
    screenshots.push(output);
  };
  const items = async (kind: "models" | "thinking" | "tools"): Promise<Item[]> =>
    browser.evaluate(
      domExpression({ kind }, Math.min(5_000, remaining())),
      itemsSchema,
      Math.min(6_000, remaining()),
    );
  const models = async (): Promise<Item[]> => {
    await browser.click(MODEL_BUTTON);
    return items("models");
  };
  const thinking = async (): Promise<Item[]> => {
    const exists = await browser.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(THINKING_BUTTON)}))`,
      z.boolean(),
    );
    if (!exists) return [];
    await browser.click(THINKING_BUTTON);
    return items("thinking");
  };
  const tools = async (): Promise<Item[]> => {
    await browser.click(TOOL_BUTTON);
    return items("tools");
  };
  const close = async (): Promise<void> => {
    // Thinking is a nested menu. Escape once for it and once for its parent.
    await browser.press("Escape");
    await browser.press("Escape");
  };
  let executionError: unknown;
  let dispatched = false;
  let observedTurn: z.infer<typeof turnSchema> | undefined;
  const stopOwnedSession = async (): Promise<void> => {
    try {
      const stoppedId = await browser.stop();
      if (stoppedId) context.log?.(`[gemini-app] Stopped owned automation session ${stoppedId}.`);
    } catch (cleanupError) {
      if (executionError !== undefined)
        throw new AggregateError(
          [executionError, cleanupError],
          "Gemini execution and automation-session cleanup both failed.",
        );
      throw cleanupError;
    }
  };
  try {
    const sessionId = await browser.start(request.browser);
    context.log?.(`[gemini-app] Connected owned BrowserSkill automation session ${sessionId}.`);
    await browser.run("navigate", [
      "https://gemini.google.com/app",
      "--timeout",
      `${Math.min(30_000, remaining())}ms`,
    ]);
    await browser.evaluate(
      domExpression({ kind: "ready" }, Math.min(30_000, remaining())),
      z.boolean(),
      Math.min(31_000, remaining()),
    );

    let modelItems = await models();
    const originalModel = onlySelected(modelItems, "model").label;
    let thinkingItems = await thinking();
    const originalThinking = thinkingItems.length
      ? (thinkingLabels[onlySelected(thinkingItems, "thinking").label] ??
        onlySelected(thinkingItems, "thinking").label)
      : null;
    await close();
    const requestedModel = request.model === "current" ? originalModel : request.model;
    const model = modelItems.find((item) => item.label === requestedModel);
    if (!model || model.disabled)
      throw new GeminiAppError(
        "selection",
        model?.disabled
          ? `Gemini model is disabled in the current UI: ${requestedModel}. No prompt was submitted.`
          : `Gemini model unavailable: ${requestedModel}. Available: ${modelItems
              .filter((item) => !item.disabled)
              .map((item) => item.label)
              .join(", ")}`,
      );
    modelItems = await models();
    if (request.action === "run" && !model.selected) {
      const currentTarget = modelItems.find(
        (item) => item.label === requestedModel && !item.disabled,
      );
      if (!currentTarget)
        throw new GeminiAppError("selection", `Gemini model disappeared: ${requestedModel}.`);
      await browser.click(currentTarget.selector);
      await close();
      modelItems = await models();
    }
    thinkingItems = await thinking();
    const requestedThinking = request.thinking === "current" ? originalThinking : request.thinking;
    if (request.action === "run" && requestedThinking !== null) {
      const effort = thinkingItems.find(
        (item) =>
          (thinkingLabels[item.label] ?? item.label) === requestedThinking && !item.disabled,
      );
      if (!effort)
        throw new GeminiAppError("selection", `Gemini thinking unavailable: ${requestedThinking}.`);
      if (!effort.selected) await browser.click(effort.selector);
    }
    await close();
    let toolItems = await tools();
    const availableModes = [
      "chat",
      ...new Set(
        toolItems
          .filter((item) => !item.disabled)
          .flatMap((item) => (toolModes[item.label] ? [toolModes[item.label]] : [])),
      ),
    ];
    let actualMode: GeminiAppMode = "chat";
    if (request.action === "run") {
      if (!availableModes.includes(request.mode))
        throw new GeminiAppError("unavailable", `Gemini tool unavailable: ${request.mode}.`);
      // Clear every selected tool, including Canvas/guided learning, before selecting this run's tool.
      const activeCount = toolItems.filter((item) => item.selected).length;
      for (let index = 0; index < activeCount; index += 1) {
        const active = toolItems.find((item) => item.selected);
        if (!active) break;
        await browser.click(active.selector);
        await close();
        toolItems = await tools();
      }
      if (request.mode !== "chat") {
        const tool = toolItems.find(
          (item) => toolModes[item.label] === request.mode && !item.disabled,
        );
        if (!tool)
          throw new GeminiAppError("unavailable", `Gemini tool unavailable: ${request.mode}.`);
        await browser.click(tool.selector);
        await close();
        toolItems = await tools();
      }
    }
    const activeTools = toolItems.filter((item) => item.selected);
    if (activeTools.length > 1)
      throw new GeminiAppError("selection", "Multiple Gemini tools remain selected.");
    if (activeTools[0]) {
      const mode = toolModes[activeTools[0].label];
      if (!mode)
        throw new GeminiAppError(
          "selection",
          `Unsupported Gemini tool is active: ${activeTools[0].label}.`,
        );
      actualMode = mode;
    }
    if (request.action === "run" && actualMode !== request.mode)
      throw new GeminiAppError(
        "selection",
        `Gemini tool selection mismatch: requested ${request.mode}, observed ${actualMode}.`,
      );
    await close();
    const chips = await browser.evaluate(
      `Array.from(document.querySelectorAll('.toolbox-drawer-item-deselect-button, button[aria-label^="取消選取"], button[aria-label^="Deselect"]')).filter(element => element.getClientRects().length > 0).map(element => element.getAttribute("aria-label") || element.textContent || "")`,
      z.array(z.string()),
    );
    const chipPatterns: Readonly<Record<GeminiAppMode, RegExp>> = {
      chat: /(?!)^/,
      image: /圖片|圖像|image/i,
      video: /影片|video/i,
      music: /音樂|music/i,
      "deep-research": /Deep Research/i,
    };
    if (
      (actualMode === "chat" && chips.length !== 0) ||
      (actualMode !== "chat" &&
        (chips.length !== 1 || !chipPatterns[actualMode].test(chips[0] ?? "")))
    ) {
      throw new GeminiAppError(
        "selection",
        `Gemini active composer tool does not match observed mode ${actualMode}.`,
      );
    }

    if (request.action === "run") await browser.fill(EDITOR, request.prompt ?? "");
    // Reopen immediately before dispatch, after fill/tool selection; click success is not proof.
    modelItems = await models();
    const actualModel = onlySelected(modelItems, "model").label;
    thinkingItems = await thinking();
    const actualThinking = thinkingItems.length
      ? (thinkingLabels[onlySelected(thinkingItems, "thinking").label] ??
        onlySelected(thinkingItems, "thinking").label)
      : null;
    if (
      request.action === "run" &&
      (actualModel !== requestedModel || actualThinking !== requestedThinking)
    ) {
      throw new GeminiAppError(
        "selection",
        `Gemini selection mismatch: requested ${requestedModel}/${requestedThinking}, observed ${actualModel}/${actualThinking}.`,
      );
    }
    await screenshot("selection");
    await close();
    const selection = { model: actualModel, thinking: actualThinking, mode: actualMode };
    const availableModels = modelItems.filter((item) => !item.disabled).map((item) => item.label);
    const availableThinking = thinkingItems
      .filter((item) => !item.disabled)
      .map((item) => thinkingLabels[item.label] ?? item.label);
    const artifacts: SessionArtifact[] = [];
    if (request.action === "discovery") {
      const conversationUrl = await browser.evaluate("location.href", z.url());
      return {
        text: "Observed controls only; generation and export capability have not been verified.",
        conversationUrl,
        selection,
        availableModels,
        availableThinking,
        availableModes,
        artifacts,
        screenshots,
      };
    }
    const prompt = request.prompt ?? "";
    const sendTarget = await browser.evaluate(
      domExpression(
        { kind: "send", token, prompt, mode: request.mode },
        Math.min(5_000, remaining()),
      ),
      sendSchema,
    );
    await browser.evaluate(
      domExpression({ kind: "mark", token }, Math.min(5_000, remaining())),
      z.boolean(),
    );
    dispatched = true;
    await browser.press("Enter", sendTarget.selector);
    // Native activation is not acceptance proof. Never resend after an ambiguous outcome.
    await browser.evaluate(
      domExpression({ kind: "accepted", token, prompt }, Math.min(10_000, remaining())),
      z.literal(true),
      Math.min(11_000, remaining()),
    );
    let result = await browser.evaluate(
      domExpression(
        {
          kind: "turn",
          token,
          prompt,
          mode: request.mode,
          approved: false,
          modelButtonText: sendTarget.modelButtonText,
        },
        remaining(),
      ),
      turnSchema,
      remaining(),
    );
    observedTurn = result;
    if (result.phase === "failed")
      throw new GeminiAppError("unavailable", result.failure ?? "Gemini generation failed.");
    if (request.mode === "deep-research") {
      if (result.phase !== "plan" || !result.control)
        throw new GeminiAppError(
          "unavailable",
          "Gemini Deep Research did not expose a research plan approval.",
        );
      await screenshot("research-plan");
      await browser.click(result.control);
      result = await browser.evaluate(
        domExpression(
          {
            kind: "turn",
            token,
            prompt,
            mode: request.mode,
            approved: true,
            modelButtonText: sendTarget.modelButtonText,
          },
          remaining(),
        ),
        turnSchema,
        remaining(),
      );
      observedTurn = result;
      if (result.phase === "failed")
        throw new GeminiAppError("unavailable", result.failure ?? "Gemini research failed.");
      if (result.phase !== "complete" || !result.citations.length)
        throw new GeminiAppError(
          "unavailable",
          "Gemini Deep Research report is not complete with citations.",
        );
      const report = path.join(request.outputDir, `${token}-research.md`);
      const contents = `${result.text}\n\n## Sources\n${result.citations.map((citation) => `- [${citation.title || citation.url}](${citation.url})`).join("\n")}\n`;
      await fs.writeFile(report, contents, { flag: "wx" });
      const bytes = await fs.readFile(report);
      artifacts.push({
        kind: "deep-research-report",
        path: report,
        label: "Gemini Deep Research report",
        mimeType: "text/markdown",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        validation: { type: "generic", ok: true },
        origin: { mode: "local" },
      });
    } else if (request.mode !== "chat") {
      if (!result.control)
        throw new GeminiAppError("artifact", "Gemini completed without a media capture target.");
      const download = path.join(request.outputDir, `${token}-${request.mode}.download`);
      const budget = Math.min(45_000, remaining());
      const capture = await browser.evaluate(
        mediaCaptureExpression(request.mode, result.control, budget),
        mediaCaptureSchema,
        budget + 1_000,
      );
      const encoded = capture.dataUrl.split(",")[1];
      if (!encoded)
        throw new GeminiAppError("artifact", "Gemini media capture returned no base64 bytes.");
      const bytes = Buffer.from(encoded, "base64");
      if (capture.byteLength !== undefined && bytes.length !== capture.byteLength)
        throw new GeminiAppError(
          "artifact",
          "Gemini media capture byte length does not match its Blob.",
        );
      await fs.writeFile(download, bytes, { flag: "wx" });
      const artifact = await verifyMediaArtifact(download, request.mode);
      if (artifact.mimeType !== capture.mimeType)
        throw new GeminiAppError(
          "artifact",
          "Gemini media capture MIME does not match its actual bytes.",
        );
      artifacts.push(
        request.mode === "image"
          ? {
              ...artifact,
              label: `Gemini rendered-image (displayed-resolution ${capture.width}x${capture.height}; decoded pixels, not original-resolution download)`,
              sourceUrl: result.url,
            }
          : artifact,
      );
    }
    await screenshot("complete");
    return {
      text: result.text,
      conversationUrl: result.url,
      selection,
      availableModels,
      availableThinking,
      availableModes,
      artifacts,
      screenshots,
    };
  } catch (error) {
    let failure: unknown = error;
    if (dispatched) {
      const captureErrors: string[] = [];
      try {
        await screenshot("failure");
      } catch (captureError) {
        captureErrors.push(
          captureError instanceof Error ? captureError.message : String(captureError),
        );
      }
      const evidencePath = path.join(request.outputDir, `${token}-failure.json`);
      try {
        await fs.writeFile(
          evidencePath,
          JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
              actualReply: observedTurn?.text ?? null,
              conversationUrl: observedTurn?.url ?? null,
              requested: { model: request.model, thinking: request.thinking, mode: request.mode },
              screenshots,
              captureErrors,
              submissionMayHaveBeenAccepted: true,
              automaticRetryPerformed: false,
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        failure = new GeminiAppError(
          error instanceof GeminiAppError ? error.code : "browser",
          `${error instanceof Error ? error.message : String(error)} Evidence: ${evidencePath}`,
          { cause: error, evidencePath },
        );
      } catch (evidenceError) {
        failure = new AggregateError(
          [error, evidenceError],
          "Gemini failed and its failure evidence could not be saved.",
        );
      }
    }
    executionError = failure;
    throw failure;
  } finally {
    await stopOwnedSession();
  }
}
