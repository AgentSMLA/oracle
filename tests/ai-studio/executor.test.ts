import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domExpression } from "../../src/ai-studio/dom.js";
import { runAiStudio } from "../../src/ai-studio/executor.js";
import type { GeminiAppRequest } from "../../src/gemini-app/types.js";
import { FixtureElement as Element, fixtureDom } from "../gemini-app/fixtureDom.js";

const cli = vi.hoisted(() => ({
  execute: (_args: string[], _signal?: AbortSignal): Promise<string> =>
    Promise.reject(new Error("Fixture not initialized")),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _binary: string,
    args: string[],
    options: { signal?: AbortSignal },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cli.execute(args, options.signal).then(
      (stdout) => callback(null, stdout, ""),
      (error: Error) => callback(error, "", ""),
    );
  },
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3l8AAAAASUVORK5CYII=",
  "base64",
);
const prompt = "PROMPT_SENTINEL";
const user = (value = prompt): Element =>
  new Element("ms-chat-turn").append(
    new Element("div", "", { class: "chat-turn-container user" }).append(
      new Element("span", "User 10:27"),
      new Element("div", "", { class: "user-prompt-container", "data-turn-role": "User" }).append(
        new Element("ms-prompt-chunk").append(new Element("ms-text-chunk", value)),
      ),
      new Element("button", "Edit"),
      new Element("button", "More actions"),
    ),
  );
const model = (value: string): Element =>
  new Element("ms-chat-turn").append(
    new Element("div", "MODEL ACTIONS", { class: "chat-turn-container model" }),
    new Element("div", "", { class: "model-prompt-container", "data-turn-role": "Model" }).append(
      new Element("ms-prompt-chunk").append(new Element("ms-text-chunk", value)),
    ),
  );
const studio = (): ReturnType<typeof fixtureDom> => {
  const dom = fixtureDom();
  const evaluate = dom.evaluate;
  return {
    ...dom,
    evaluate: (expression) =>
      evaluate(
        `(location.hostname = "aistudio.google.com", location.origin = "https://aistudio.google.com", location.href = "https://aistudio.google.com/prompts/fixture", globalThis.HTMLElement = Element, ${expression})`,
      ),
  };
};
let root: string;
let calls: string[][];
let dom: ReturnType<typeof studio>;
let modelButton: Element;
let effort: Element;
let runLabel: Element;
let editor: Element & { value: string };
let ignoreModel: boolean;
let modelClosing: boolean;
let driftOnFill: boolean;
let stopError: boolean;
let onFill: (() => void) | undefined;

const argument = (args: string[], flag: string): string => {
  const value = args[args.indexOf(flag) + 1];
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
};
const setModel = (code: string): void => {
  modelButton.querySelector('[data-test-id="model-name"]')?.remove();
  modelButton.append(new Element("span", code, { "data-test-id": "model-name" }));
};
const submitted = (): boolean => calls.some((args) => args[0] === "press");
const stopped = (): boolean =>
  calls.some((args) => args[0] === "session" && args[1] === "stop" && args[2] === "owned-studio");
const request = (overrides: Partial<GeminiAppRequest> = {}): GeminiAppRequest => ({
  site: "ai-studio",
  action: "run",
  prompt,
  model: "current",
  thinking: "current",
  mode: "chat",
  outputDir: root,
  timeoutMs: 10_000,
  ...overrides,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-ai-studio-"));
  calls = [];
  ignoreModel = false;
  modelClosing = false;
  driftOnFill = false;
  stopError = false;
  onFill = undefined;
  dom = studio();
  modelButton = new Element("button", "", { class: "model-selector-card" });
  setModel("gemini-3.5-flash-lite");
  effort = new Element("div", "Minimal", { role: "combobox", "aria-label": "Thinking Level" });
  runLabel = new Element("span", "Run", { class: "run-button-label" });
  editor = Object.assign(new Element("textarea", "", { "aria-label": "Enter a prompt" }), {
    value: "",
  });
  dom.root.append(
    modelButton,
    effort,
    editor,
    new Element("button", "", { class: "ctrl-enter-submits", "aria-disabled": "false" }).append(
      runLabel,
    ),
    user(),
    model("STALE_REPLY"),
  );
  cli.execute = async (args, signal) => {
    calls.push(args);
    signal?.throwIfAborted();
    if (args[0] === "session") {
      if (args[1] === "stop" && stopError) throw new Error("CLEANUP_SENTINEL");
      return JSON.stringify(args[1] === "start" ? { session_id: "owned-studio" } : { ok: true });
    }
    if (args[0] === "evaluate") {
      const expression = args[1] ?? "";
      const pending = dom.evaluate(expression);
      if (modelClosing && expression.includes(')({"kind":"closed"')) {
        expect(dom.observers()).toBe(1);
        dom.mutate(() => {
          for (const node of dom.root.querySelectorAll('button[id^="model-carousel-row-models/"]'))
            node.remove();
          dom.root.querySelector('button[aria-label="Close panel"]')?.remove();
          modelClosing = false;
        });
      }
      if (expression.includes(')({"kind":"turn"') && dom.observers() > 0) dom.expire();
      return JSON.stringify({ ok: true, value: await pending });
    }
    if (args[0] === "screenshot") await fs.writeFile(argument(args, "--out"), png);
    if (args[0] === "fill") {
      editor.value = argument(args, "--value");
      if (driftOnFill) setModel("gemini-3.8-flash");
      onFill?.();
    }
    if (args[0] === "click") {
      const selector = argument(args, "--selector");
      if (selector === "button.model-selector-card") {
        dom.root.append(
          new Element("button", "", { "aria-label": "Close panel" }),
          ...[
            ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"],
            ["gemini-4-argon", "Gemini 4 Argon"],
          ].map(([code, title]) =>
            new Element("button", "", { id: `model-carousel-row-models/${code}` }).append(
              new Element("span", title, { class: "model-title-text" }),
            ),
          ),
        );
      } else if (selector.startsWith("[id=")) {
        if (!ignoreModel) setModel(selector.includes("gemini-4-argon") ? "gemini-4-argon" : "");
        modelClosing = true;
      } else if (selector.includes("Close panel")) {
        if (modelClosing) throw new Error("Extra Close click during automatic model-panel closure");
        for (const node of dom.root.querySelectorAll('button[id^="model-carousel-row-models/"]'))
          node.remove();
        dom.root.querySelector('button[aria-label="Close panel"]')?.remove();
      } else if (selector.includes('role="combobox"')) {
        dom.root.append(
          new Element("div", "", { role: "listbox", "aria-label": "Thinking Level" }).append(
            ...["Minimal", "Low", "Medium", "High"].map(
              (title) => new Element("div", title, { role: "option" }),
            ),
          ),
        );
      } else if (selector.includes("data-oracle-ai-option")) {
        const option = dom.root.querySelector(selector);
        effort.remove();
        effort = new Element("div", option?.textContent.trim(), {
          role: "combobox",
          "aria-label": "Thinking Level",
        });
        dom.root.append(effort);
        dom.root.querySelector('[role="listbox"]')?.remove();
      }
    }
    if (args[0] === "press") dom.root.append(user(), model("FRESH_REPLY\n\n- preserved line"));
    return JSON.stringify({ ok: true });
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("AI Studio through the BrowserSkill CLI boundary", () => {
  it.each(["image", "video", "music", "deep-research"] as const)(
    "rejects %s before allocating",
    async (mode) => {
      await expect(runAiStudio(request({ mode }))).rejects.toThrow("supports chat only");
      expect(calls).toEqual([]);
    },
  );
  it.each([{ prompt: "" }, { timeoutMs: 0 }, { outputDir: "relative" }])(
    "rejects malformed requests before allocating: %j",
    async (override) => {
      await expect(runAiStudio(request(override))).rejects.toThrow();
      expect(calls).toEqual([]);
    },
  );
  it("discovers actual codes including Argon without sending", async () => {
    const result = await runAiStudio(request({ action: "discovery" }));
    expect(result.availableModels).toContain("gemini-4-argon");
    expect(result.selection).toEqual({
      model: "gemini-3.5-flash-lite",
      thinking: "minimal",
      mode: "chat",
    });
    expect(result.screenshots).toHaveLength(1);
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
    expect(
      calls.filter(
        (args) => args[0] === "click" && args.includes('button[aria-label="Close panel"]'),
      ),
    ).toHaveLength(1);
  });
  it.each(["gemini-4-argon", "Gemini 4 Argon"])(
    "allows exact production selection %s without test generation",
    async (model) => {
      const result = await runAiStudio(request({ action: "discovery", model, thinking: "high" }));
      expect(result.selection.model).toBe("gemini-4-argon");
      expect(result.selection.thinking).toBe("high");
      expect(submitted()).toBe(false);
      expect(
        calls.some(
          (args) => args[0] === "click" && args.includes('button[aria-label="Close panel"]'),
        ),
      ).toBe(false);
      expect(modelClosing).toBe(false);
      expect(dom.observers()).toBe(0);
    },
  );
  it("rejects aliases without downgrade or submission", async () => {
    await expect(runAiStudio(request({ model: "argon" }))).rejects.toThrow(
      "exact model unavailable",
    );
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });
  it("fails an ignored model selection before sending", async () => {
    ignoreModel = true;
    await expect(runAiStudio(request({ model: "gemini-4-argon" }))).rejects.toThrow(
      "exact requested",
    );
    expect(submitted()).toBe(false);
  });
  it("rechecks exact selection after fill before send", async () => {
    driftOnFill = true;
    await expect(runAiStudio(request())).rejects.toThrow("selection changed");
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
  });
  it("returns fresh output and actual saved screenshots without fabricated artifacts", async () => {
    const result = await runAiStudio(request());
    expect(result.text).toBe("FRESH_REPLY\n\n- preserved line");
    expect(result.artifacts).toEqual([]);
    expect(result.screenshots).toHaveLength(2);
    for (const file of result.screenshots) expect(await fs.readFile(file)).toEqual(png);
    expect(stopped()).toBe(true);
  });
  it("cleans up after cancellation without sending", async () => {
    const controller = new AbortController();
    onFill = () => controller.abort(new Error("CANCEL_SENTINEL"));
    await expect(runAiStudio(request(), { signal: controller.signal })).rejects.toThrow(
      "CANCEL_SENTINEL",
    );
    expect(submitted()).toBe(false);
    expect(stopped()).toBe(true);
    const cleanup = calls.find((args) => args[0] === "session" && args[1] === "stop");
    expect(cleanup).toContain("owned-studio");
  });
  it("preserves simultaneous execution and cleanup failures", async () => {
    driftOnFill = true;
    stopError = true;
    const error: unknown = await runAiStudio(request()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected AggregateError");
    expect(error.errors.map(String).join("\n")).toMatch(/selection changed[\s\S]*CLEANUP_SENTINEL/);
  });
});

describe("AI Studio mutation protocol", () => {
  it("requires popup removal even after visibility disappears", async () => {
    const popup = new Element("div", "", { role: "listbox", "aria-label": "Thinking Level" });
    dom.root.append(popup);
    const pending = dom.evaluate(
      domExpression({ kind: "closed", selector: '[role="listbox"]' }, 500),
    );
    dom.mutate(() => {
      popup.hidden = true;
    });
    expect(dom.observers()).toBe(1);
    dom.mutate(() => popup.remove());
    expect(await pending).toBe(true);
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });
  it("ignores all preexisting turns and waits for matching fresh user then model and Run", async () => {
    await dom.evaluate(domExpression({ kind: "mark", token: "fresh" }, 500));
    const pending = dom.evaluate(domExpression({ kind: "turn", token: "fresh", prompt }, 500));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => dom.root.append(user("WRONG_PROMPT"), model("WRONG_REPLY")));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => {
      runLabel.remove();
      runLabel = new Element("span", "progress_activity Stop", { class: "run-button-label" });
      dom.root.querySelector("button.ctrl-enter-submits")?.append(runLabel);
      dom.root.append(user(), model("FRESH_ONLY"));
    });
    expect(dom.observers()).toBe(1);
    dom.mutate(() => {
      runLabel.remove();
      dom.root
        .querySelector("button.ctrl-enter-submits")
        ?.append(new Element("span", "Run", { class: "run-button-label" }));
    });
    expect(dom.observers()).toBe(0);
    expect(await pending).toEqual({
      text: "FRESH_ONLY",
      url: "https://aistudio.google.com/prompts/fixture",
    });
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });
  it("rejects visible billing dialogs without handling keys", async () => {
    dom.root.append(new Element("div", "Select an API key", { role: "dialog" }));
    await expect(dom.evaluate(domExpression({ kind: "ready" }, 500))).rejects.toThrow(
      "Select an API key",
    );
    expect(dom.observers()).toBe(0);
  });
  it("disconnects observers and timers on bounded timeout", async () => {
    await dom.evaluate(domExpression({ kind: "mark", token: "timeout" }, 500));
    const pending = dom.evaluate(domExpression({ kind: "turn", token: "timeout", prompt }, 500));
    const rejection = expect(pending).rejects.toThrow("timed out");
    dom.expire();
    await rejection;
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });
});
