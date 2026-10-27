import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export class GeminiAppError extends Error {
  readonly evidencePath?: string;
  constructor(
    readonly code: "browser" | "selection" | "unavailable" | "timeout" | "artifact",
    message: string,
    options?: ErrorOptions & { readonly evidencePath?: string },
  ) {
    super(message, options);
    this.name = "GeminiAppError";
    this.evidencePath = options?.evidencePath;
  }
}

export interface BrowserSkillCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export type BrowserSkillCommand = (
  binary: string,
  args: readonly string[],
  options: BrowserSkillCommandOptions,
) => Promise<string>;

const execute: BrowserSkillCommand = (binary, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, BSK_AUTO_START: "0" },
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GeminiAppError(
              "browser",
              `BrowserSkill ${args[0]} failed: ${[stdout, stderr].filter(Boolean).join("\n") || error.message}`,
              {
                cause: error,
              },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

const sessionSchema = z.object({ session_id: z.string().min(1) });
const evaluationSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.unknown().optional(),
});
const failureSchema = z.object({ ok: z.literal(false), error: z.unknown().optional() });

/** Owns only a BrowserSkill automation session, never the daemon or browser profile. */
export class BrowserSkill {
  private sessionId: string | undefined;
  private readonly binary =
    process.env.BSK_BIN ||
    path.join(homedir(), ".local", "bin", process.platform === "win32" ? "bsk.exe" : "bsk");

  constructor(
    private readonly signal?: AbortSignal,
    private readonly command: BrowserSkillCommand = execute,
  ) {}

  private async invoke(
    args: readonly string[],
    timeoutMs: number,
    cleanup = false,
  ): Promise<unknown> {
    if (!cleanup) this.signal?.throwIfAborted();
    const stdout = await this.command(this.binary, [...args, "--json"], {
      timeoutMs,
      signal: cleanup ? undefined : this.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new GeminiAppError("browser", "BrowserSkill returned invalid JSON.", { cause: error });
    }
    const failure = failureSchema.safeParse(parsed);
    if (failure.success) {
      throw new GeminiAppError(
        "browser",
        `BrowserSkill rejected ${args[0]}: ${JSON.stringify(failure.data.error)}`,
      );
    }
    return parsed;
  }

  async start(browser?: string): Promise<string> {
    const args = ["session", "start", "--no-focus"];
    if (browser) args.push("--browser", browser);
    // Do not interrupt the allocation command: a late successful allocation must be stopped.
    const response = sessionSchema.parse(await this.invoke(args, 30_000, true));
    this.sessionId = response.session_id;
    this.signal?.throwIfAborted();
    return this.sessionId;
  }

  async stop(): Promise<string | undefined> {
    const id = this.sessionId;
    if (!id) return;
    await this.invoke(["session", "stop", id], 30_000, true);
    this.sessionId = undefined;
    return id;
  }

  async run(command: string, args: readonly string[] = [], timeoutMs = 30_000): Promise<unknown> {
    if (!this.sessionId)
      throw new GeminiAppError("browser", "BrowserSkill automation session is not started.");
    return this.invoke([command, ...args, "--session", this.sessionId], timeoutMs);
  }

  async evaluate<T>(expression: string, schema: z.ZodType<T>, timeoutMs = 30_000): Promise<T> {
    const result = evaluationSchema.parse(
      await this.run("evaluate", [expression, "--timeout", `${timeoutMs}ms`], timeoutMs + 1_000),
    );
    if (!result.ok) {
      throw new GeminiAppError(
        "browser",
        `BrowserSkill evaluation failed: ${JSON.stringify(result.error)}`,
      );
    }
    return schema.parse(result.value);
  }

  async click(selector: string): Promise<void> {
    await this.run("click", ["--selector", selector]);
  }

  async press(key: string, selector?: string): Promise<void> {
    await this.run("press", selector ? [key, "--selector", selector] : [key]);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.run("fill", ["--selector", selector, "--value", value]);
  }

  async screenshot(output: string): Promise<void> {
    await this.run("screenshot", ["--out", output]);
  }

  async download(selector: string, output: string, timeoutMs: number): Promise<void> {
    // The CLI arms browser download capture BEFORE activating this target.
    await this.run(
      "download",
      ["--selector", selector, "--out", output, "--timeout", `${timeoutMs}ms`],
      timeoutMs + 1_000,
    );
  }
}
