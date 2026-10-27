import type { GeminiAppRequest } from "./types.js";
import { runGeminiApp } from "./executor.js";
import { BrowserRunCancelledError } from "../oracle/errors.js";
import type { SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";

export interface GeminiAppSessionParams {
  readonly sessionMeta: SessionMetadata;
  readonly request: GeminiAppRequest;
  readonly log: (message?: string) => void;
  readonly signal?: AbortSignal;
}

export async function performGeminiAppSession({
  sessionMeta,
  request,
  log,
  signal,
}: GeminiAppSessionParams): Promise<void> {
  const model = sessionMeta.model ?? "gemini-app";
  const startedAt = new Date().toISOString();
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt,
    completedAt: undefined,
    mode: "browser",
    errorMessage: undefined,
    response: undefined,
    error: undefined,
  });
  await sessionStore.updateModelRun(sessionMeta.id, model, {
    status: "running",
    startedAt,
    completedAt: undefined,
    response: undefined,
    error: undefined,
  });
  try {
    signal?.throwIfAborted();
    const result = await runGeminiApp(request, { signal, log });
    if (signal?.aborted) throw new BrowserRunCancelledError();
    const completedAt = new Date().toISOString();
    if (result.text) log(`\nGemini App response:\n${result.text}`);
    await sessionStore.updateSession(sessionMeta.id, {
      status: "completed",
      completedAt,
      mode: "browser",
      geminiApp: result,
      artifacts: result.artifacts,
      errorMessage: undefined,
      response: { status: "completed" },
      error: undefined,
      transport: undefined,
    });
    await sessionStore.updateModelRun(sessionMeta.id, model, {
      status: "completed",
      completedAt,
      response: { status: "completed" },
      error: undefined,
      transport: undefined,
    });
  } catch (error) {
    const cancelled =
      signal?.aborted ||
      error instanceof BrowserRunCancelledError ||
      (error instanceof Error && error.name === "AbortError");
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const status = cancelled ? "cancelled" : "error";
    log(cancelled ? "Gemini App run cancelled." : `ERROR: Gemini App run failed: ${message}`);
    await sessionStore.updateSession(sessionMeta.id, {
      status,
      completedAt,
      mode: "browser",
      errorMessage: cancelled ? undefined : message,
      response: { status },
      error: cancelled ? undefined : { category: "browser-automation", message },
      transport: undefined,
    });
    await sessionStore.updateModelRun(sessionMeta.id, model, {
      status,
      completedAt,
      response: { status },
      error: cancelled ? undefined : { category: "browser-automation", message },
      transport: undefined,
    });
    if (cancelled && !(error instanceof BrowserRunCancelledError)) {
      throw new BrowserRunCancelledError("Gemini App run cancelled by the caller or timeout.");
    }
    throw error;
  }
}
