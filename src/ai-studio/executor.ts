import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BrowserSkill, GeminiAppError } from "../gemini-app/browserSkill.js";
import type {
  GeminiAppExecutionContext,
  GeminiAppRequest,
  GeminiAppResult,
} from "../gemini-app/types.js";
import { choicesSchema, completionSchema, domExpression, selectionSchema } from "./dom.js";

const MODEL = "button.model-selector-card";
const CLOSE = 'button[aria-label="Close panel"]';
const THINKING = '[role="combobox"][aria-label="Thinking Level"]';
const LISTBOX = '[role="listbox"][aria-label="Thinking Level"]';

export async function runAiStudio(
  request: GeminiAppRequest,
  context: GeminiAppExecutionContext = {},
): Promise<GeminiAppResult> {
  context.signal?.throwIfAborted();
  if (request.mode !== "chat")
    throw new GeminiAppError("unavailable", `AI Studio supports chat only, not ${request.mode}.`);
  if (!path.isAbsolute(request.outputDir))
    throw new GeminiAppError("artifact", "AI Studio outputDir must be absolute.");
  if (request.action === "run" && !request.prompt?.trim())
    throw new GeminiAppError("unavailable", "AI Studio run requires a nonempty prompt.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
    throw new GeminiAppError("timeout", "AI Studio timeoutMs must be a positive integer.");
  await fs.mkdir(request.outputDir, { recursive: true });
  const signal = AbortSignal.any([
    ...(context.signal ? [context.signal] : []),
    AbortSignal.timeout(request.timeoutMs),
  ]);
  const browser = new BrowserSkill(signal);
  const deadline = Date.now() + request.timeoutMs;
  const evaluate = <T>(
    operation: Parameters<typeof domExpression>[0],
    schema: z.ZodType<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GeminiAppError("timeout", "AI Studio deadline expired.");
    return browser.evaluate(domExpression(operation, remaining), schema, remaining);
  };
  const token = randomUUID();
  const screenshots: string[] = [];
  const screenshot = async (label: string): Promise<void> => {
    const output = path.join(request.outputDir, `${token}-${label}.png`);
    await browser.screenshot(output);
    const stat = await fs.lstat(output);
    const bytes = await fs.readFile(output);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new GeminiAppError("artifact", "AI Studio screenshot was not saved as a PNG file.");
    screenshots.push(output);
  };
  const closeModel = async (): Promise<void> => {
    if (await evaluate({ kind: "close-present" }, z.boolean())) await browser.click(CLOSE);
    await evaluate({ kind: "closed", selector: CLOSE }, z.boolean());
  };
  let executionError: unknown;
  let failed = false;
  const stopOwnedSession = async (): Promise<void> => {
    try {
      const stopped = await browser.stop();
      if (stopped) context.log?.(`[ai-studio] Stopped owned automation session ${stopped}.`);
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [executionError, cleanupError],
          "AI Studio execution and automation-session cleanup both failed.",
        );
      throw cleanupError;
    }
  };
  try {
    const session = await browser.start(request.browser);
    context.log?.(`[ai-studio] Connected owned BrowserSkill automation session ${session}.`);
    await browser.run("navigate", ["https://aistudio.google.com/prompts/new_chat"]);
    await evaluate({ kind: "ready" }, z.boolean());
    const original = await evaluate({ kind: "selection" }, selectionSchema);
    await browser.click(MODEL);
    const models = await evaluate({ kind: "models" }, choicesSchema);
    const candidates = models.filter(
      (item) =>
        item.code === (request.model === "current" ? original.model : request.model) ||
        (request.model !== "current" && item.title === request.model),
    );
    const model = candidates[0];
    if (candidates.length !== 1 || !model || model.disabled)
      throw new GeminiAppError("selection", `AI Studio exact model unavailable: ${request.model}.`);
    if (model.code !== original.model) {
      await browser.click(model.selector);
      await evaluate({ kind: "closed", selector: CLOSE }, z.boolean());
    } else await closeModel();
    let selection = await evaluate({ kind: "selection" }, selectionSchema);
    const targetThinking = request.thinking === "current" ? selection.thinking : request.thinking;
    let thinking: z.infer<typeof choicesSchema> = [];
    if (selection.thinking !== null) {
      await browser.click(THINKING);
      thinking = await evaluate({ kind: "thinking" }, choicesSchema);
      const choices = thinking.filter((item) => item.code === targetThinking && !item.disabled);
      if (choices.length !== 1 || !choices[0])
        throw new GeminiAppError("selection", `AI Studio thinking unavailable: ${targetThinking}.`);
      await browser.click(choices[0].selector);
      await evaluate({ kind: "closed", selector: LISTBOX }, z.boolean());
    } else if (targetThinking !== null) {
      throw new GeminiAppError("selection", `AI Studio thinking unavailable: ${targetThinking}.`);
    }
    selection = await evaluate({ kind: "selection" }, selectionSchema);
    if (selection.model !== model.code || selection.thinking !== targetThinking)
      throw new GeminiAppError(
        "selection",
        "AI Studio did not retain the exact requested selection.",
      );
    await screenshot("selection");
    let text = "";
    let conversationUrl = await browser.evaluate("location.href", z.string());
    if (request.action === "run") {
      const prompt = request.prompt ?? "";
      await browser.fill('textarea[aria-label="Enter a prompt"]', prompt);
      await evaluate(
        { kind: "send", model: model.code, thinking: targetThinking, prompt },
        z.boolean(),
      );
      await evaluate({ kind: "mark", token }, z.boolean());
      await browser.press("Enter", "button.ctrl-enter-submits");
      const completion = await evaluate({ kind: "turn", token, prompt }, completionSchema);
      text = completion.text;
      conversationUrl = completion.url;
      await screenshot("complete");
    }
    return {
      text,
      conversationUrl,
      selection: { ...selection, mode: "chat" },
      availableModels: models.filter((item) => !item.disabled).map((item) => item.code),
      availableThinking: thinking.filter((item) => !item.disabled).map((item) => item.code),
      availableModes: ["chat"],
      screenshots,
      artifacts: [],
    };
  } catch (error) {
    failed = true;
    executionError = error;
    throw error;
  } finally {
    await stopOwnedSession();
  }
}
