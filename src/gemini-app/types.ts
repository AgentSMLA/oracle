import type { SessionArtifact } from "../sessionStore.js";

export type GeminiAppThinking = "current" | "minimal" | "low" | "medium" | "high";
export type GeminiAppMode = "chat" | "image" | "video" | "music" | "deep-research";

/** Normalized once at the MCP boundary, then preserved verbatim in session storage. */
export interface GeminiAppRequest {
  readonly site?: "gemini-app" | "ai-studio";
  readonly action: "discovery" | "run";
  readonly prompt?: string;
  readonly model: string;
  readonly thinking: GeminiAppThinking;
  readonly mode: GeminiAppMode;
  readonly outputDir: string;
  readonly timeoutMs: number;
  readonly browser?: string;
}

export interface GeminiAppSelection {
  readonly model: string;
  readonly thinking: string | null;
  readonly mode: GeminiAppMode;
}

export interface GeminiAppResult {
  readonly text: string;
  readonly conversationUrl: string;
  readonly selection: GeminiAppSelection;
  readonly availableModels: readonly string[];
  readonly availableThinking: readonly string[];
  readonly availableModes: readonly string[];
  readonly artifacts: SessionArtifact[];
  readonly screenshots: readonly string[];
}

export interface GeminiAppExecutionContext {
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}
