import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOracleHomeDir } from "../../oracleHome.js";
import { getCliVersion } from "../../version.js";
import { sessionStore } from "../../sessionStore.js";
import { performSessionRun } from "../../cli/sessionRunner.js";
import { launchDetachedSession } from "../../cli/detachedSession.js";
import { buildSessionLifecycle } from "../../cli/sessionLifecycle.js";
import { resolveMcpOutputPath } from "../utils.js";
import type { GeminiAppRequest } from "../../gemini-app/types.js";
import { summarizeArtifactsForConsult, summarizeImageArtifactsForConsult } from "./consult.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const geminiAppInputShape = {
  site: z.enum(["gemini-app", "ai-studio"]).default("gemini-app"),
  action: z
    .enum(["discovery", "run"])
    .describe("Discover controls without submitting a prompt, or run a Gemini request."),
  prompt: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Prompt to submit; required for action=run."),
  model: z
    .string()
    .trim()
    .min(1)
    .default("current")
    .describe(
      'Exact model code or full display title, or "current" to preserve the starting selection.',
    ),
  thinking: z.enum(["current", "minimal", "low", "medium", "high"]).default("current"),
  mode: z.enum(["chat", "image", "video", "music", "deep-research"]).default("chat"),
  outputDir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Directory for confirmed artifacts under Oracle generated output; external paths require the existing MCP output opt-in.",
    ),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  browser: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional BrowserSkill browser selector; no browser profile or cookie is supplied by this tool.",
    ),
  waitForCompletion: z
    .boolean()
    .default(true)
    .describe("When false, return a durable Oracle session id for the wait tool."),
  slug: z.string().trim().min(1).optional().describe("Optional human-friendly Oracle session id."),
} satisfies z.ZodRawShape;

export const geminiAppInputSchema = z
  .object(geminiAppInputShape)
  .strict()
  .superRefine((input, context) => {
    if (input.action === "run" && !input.prompt) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "prompt is required for action=run.",
      });
    }
  });

const artifactShape = z.object({
  kind: z.enum(["transcript", "deep-research-report", "image", "file"]),
  path: z.string(),
  label: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  sourceUrl: z.string().optional(),
  sha256: z.string().optional(),
  validation: z
    .object({ type: z.enum(["generic", "zip"]), ok: z.boolean(), error: z.string().optional() })
    .optional(),
  transfer: z
    .object({
      status: z.enum(["not-needed", "ready", "streaming", "completed", "failed", "skipped"]),
      bytes: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
  origin: z.object({ mode: z.enum(["local", "bridge"]), host: z.string().optional() }).optional(),
});
const geminiAppResultShape = z.object({
  text: z.string(),
  conversationUrl: z.string(),
  selection: z.object({
    model: z.string(),
    thinking: z.string().nullable(),
    mode: z.enum(["chat", "image", "video", "music", "deep-research"]),
  }),
  availableModels: z.array(z.string()),
  availableThinking: z.array(z.string()),
  availableModes: z.array(z.string()),
  artifacts: z.array(artifactShape),
  screenshots: z.array(z.string()),
});
const geminiAppOutputShape = {
  sessionId: z.string(),
  status: z.string(),
  detached: z.boolean(),
  output: z.string(),
  geminiApp: geminiAppResultShape.optional(),
  artifacts: z.array(artifactShape).optional(),
  images: z.array(artifactShape).optional(),
  models: z.array(z.object({ model: z.string(), status: z.string() })).optional(),
} satisfies z.ZodRawShape;

export function resolveGeminiAppRequest(input: unknown): {
  request: GeminiAppRequest;
  waitForCompletion: boolean;
  slug?: string;
} {
  const parsed = geminiAppInputSchema.parse(input);
  const requestedOutput =
    parsed.outputDir ?? path.join(getOracleHomeDir(), "generated", `gemini-app-${randomUUID()}`);
  const outputDir = resolveMcpOutputPath(requestedOutput, "outputPath");
  return {
    request: {
      action: parsed.action,
      ...(parsed.site === "ai-studio" ? { site: parsed.site } : {}),
      model: parsed.model,
      thinking: parsed.thinking,
      mode: parsed.mode,
      outputDir,
      timeoutMs: parsed.timeoutMs,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      ...(parsed.browser ? { browser: parsed.browser } : {}),
    },
    waitForCompletion: parsed.waitForCompletion,
    ...(parsed.slug ? { slug: parsed.slug } : {}),
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

export interface GeminiAppToolDeps {
  readonly launchDetached: typeof launchDetachedSession;
  readonly runSession: typeof performSessionRun;
}

const defaultDeps: GeminiAppToolDeps = {
  launchDetached: launchDetachedSession,
  runSession: performSessionRun,
};

export async function runGeminiAppTool(
  input: unknown,
  deps: GeminiAppToolDeps = defaultDeps,
): Promise<CallToolResult> {
  let resolved: ReturnType<typeof resolveGeminiAppRequest>;
  try {
    resolved = resolveGeminiAppRequest(input);
  } catch (error) {
    return errorResult(error);
  }
  const { request, waitForCompletion, slug } = resolved;
  const runOptions = {
    prompt: request.prompt ?? "Gemini App discovery",
    model: "gemini-app",
    geminiApp: request,
  };
  try {
    const sessionMeta = await sessionStore.createSession(
      { ...runOptions, mode: "browser", slug, waitPreference: waitForCompletion },
      process.cwd(),
    );
    const runWithIds = { ...runOptions, sessionId: sessionMeta.id };
    const foregroundLifecycle = buildSessionLifecycle({
      engine: "browser",
      detached: false,
      reattachCommand: `oracle session ${sessionMeta.id}`,
    });
    if (!waitForCompletion) {
      try {
        await deps.launchDetached({
          sessionId: sessionMeta.id,
          prepare: async (workerPid) => {
            const lifecycle = buildSessionLifecycle({
              engine: "browser",
              detached: true,
              workerPid,
              reattachCommand: `oracle session ${sessionMeta.id}`,
            });
            await sessionStore.updateSession(sessionMeta.id, {
              status: "running",
              startedAt: new Date().toISOString(),
              lifecycle,
            });
          },
        });
        return {
          content: [
            {
              type: "text",
              text: `Session ${sessionMeta.id} (running; detached). Use wait with id=${JSON.stringify(sessionMeta.id)}.`,
            },
          ],
          structuredContent: {
            sessionId: sessionMeta.id,
            status: "running",
            detached: true,
            output: "",
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const completedAt = new Date().toISOString();
        await sessionStore.updateModelRun(sessionMeta.id, "gemini-app", {
          status: "error",
          completedAt,
          response: { status: "error" },
          error: { category: "internal", message },
        });
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt,
          errorMessage: message,
          response: { status: "error" },
          error: { category: "internal", message },
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unable to start detached session ${sessionMeta.id}: ${message}`,
            },
          ],
          structuredContent: {
            sessionId: sessionMeta.id,
            status: "error",
            detached: false,
            output: "",
          },
        };
      }
    }
    await sessionStore.updateSession(sessionMeta.id, { lifecycle: foregroundLifecycle });
    const writer = sessionStore.createLogWriter(sessionMeta.id);
    try {
      await deps.runSession({
        sessionMeta,
        runOptions: runWithIds,
        mode: "browser",
        cwd: process.cwd(),
        log: writer.logLine,
        write: writer.writeChunk,
        version: getCliVersion(),
        muteStdout: true,
      });
    } catch (error) {
      const metadata = (await sessionStore.readSession(sessionMeta.id)) ?? sessionMeta;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Session ${sessionMeta.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        structuredContent: {
          sessionId: sessionMeta.id,
          status: metadata.status,
          detached: false,
          output: "",
        },
      };
    } finally {
      writer.stream.end();
    }
    const metadata = (await sessionStore.readSession(sessionMeta.id)) ?? sessionMeta;
    const output = await sessionStore.readLog(sessionMeta.id);
    return {
      ...(metadata.status === "completed" ? {} : { isError: true }),
      content: [{ type: "text", text: metadata.geminiApp?.text || output }],
      structuredContent: {
        sessionId: metadata.id,
        status: metadata.status,
        detached: false,
        output,
        geminiApp: metadata.geminiApp,
        artifacts: summarizeArtifactsForConsult(metadata.artifacts),
        images: summarizeImageArtifactsForConsult(metadata.artifacts),
        models: metadata.models?.map(({ model, status }) => ({ model, status })),
      },
    };
  } catch (error) {
    return errorResult(error);
  }
}

export function registerGeminiAppTool(server: McpServer): void {
  server.registerTool(
    "gemini_app",
    {
      title: "Discover or run Gemini App or AI Studio",
      description:
        'Use site="gemini-app" (default) or site="ai-studio" through a connected, signed-in BrowserSkill browser. AI Studio discovery and runs support Playground chat only. BrowserSkill must be installed, running, connected, and authenticated to the selected site; this tool does not launch a browser, obtain cookies, or provide sign-in. Discovery submits no prompt. Select an exact model code or full display title, including production models such as gemini-4-argon, or "current"; no model fallback is used. Exact requested selections and only confirmed saved artifacts are persisted in an Oracle session.',
      inputSchema: geminiAppInputSchema,
      outputSchema: z.object(geminiAppOutputShape),
    },
    async (input: unknown) => runGeminiAppTool(input),
  );
}
