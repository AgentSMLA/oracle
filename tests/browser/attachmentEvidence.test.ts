import { describe, expect, test, vi } from "vitest";
import { buildAttachmentEvidenceExpression } from "../../src/browser/actions/attachmentEvidence.js";
import {
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForAttachmentVisible,
} from "../../src/browser/actions/attachments.js";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

function fixture() {
  const form = new FakeElement("form", { "data-testid": "composer" }, [
    new FakeElement("textarea", { id: "prompt-textarea" }),
    new FakeInputElement([]),
    new FakeElement("button", { "data-testid": "send-button" }),
  ]);
  const document = new FakeDocument([form]);
  const renderer = {};
  const evaluate = (expression: string) =>
    new Function(
      "document",
      "HTMLElement",
      "HTMLInputElement",
      "window",
      "globalThis",
      "location",
      `return ${expression};`,
    )(
      document,
      FakeElement,
      FakeInputElement,
      { getComputedStyle: () => ({ pointerEvents: "auto" }) },
      renderer,
      new URL("https://chatgpt.com/"),
    );
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression) },
    })),
  };
  const action = (
    names: string[],
    kind: "read" | "begin" | "confirm" | "clear" = "read",
    id?: string,
  ) => evaluate(buildAttachmentEvidenceExpression(names, kind, id));
  const addPreview = (parent = form) => {
    const control = new FakeElement("button", { "aria-label": "Remove attachment" });
    parent.append(new FakeElement("div", { "data-testid": "attachment-chip" }, [control]));
    return control;
  };
  const addCurrentPreview = (name: string, parent = form, label = `${name} を削除`) => {
    const control = new FakeElement("button", {
      type: "button",
      "aria-label": label,
      class: "opacity-0 pointer-events-none group-hover/composer-attachment:opacity-100",
    });
    parent.append(
      new FakeElement("div", { "data-composer-attachments": "", "data-visible-attachments": "" }, [
        new FakeElement("div", {}, [
          new FakeElement("span", { class: "group/composer-attachment" }, [
            new FakeElement("span", {}, [
              new FakeElement("span", { class: "truncate" }, [], name),
              new FakeElement("button", { type: "button", "aria-label": name }),
            ]),
            control,
          ]),
        ]),
      ]),
    );
    return control;
  };
  return { form, document, runtime, evaluate, action, addPreview, addCurrentPreview };
}

function currentComposerFixture(hasSend = false, explicitRoot = "form") {
  const f = fixture();
  f.form.remove();
  const prompt = new FakeElement("div", {
    class: "ProseMirror",
    contenteditable: "true",
    role: "textbox",
    "data-composer-markdown": "true",
  });
  const send = new FakeElement("button", { "data-testid": "send-button" });
  const voice = new FakeElement("button", { "aria-label": "音声モードを開始する" });
  const body = new FakeElement("div", { class: "ComposerLayoutBody" }, [
    prompt,
    hasSend ? send : voice,
  ]);
  const root = new FakeElement(
    explicitRoot === "form" ? "form" : "div",
    explicitRoot === "composer" ? { "data-testid": "composer" } : {},
    [new FakeInputElement([]), body],
  );
  f.document.body.append(root);
  return { ...f, root, body, prompt, send, voice };
}

describe("per-file attachment evidence", () => {
  test.each(["form", "composer"])(
    "begins in an empty %s before send mounts and confirms a Japanese card",
    (root) => {
      const f = currentComposerFixture(false, root);
      expect(f.action(["file.md"], "begin", "current")).toBe(true);
      f.voice.remove();
      f.body.append(f.send);
      f.addCurrentPreview("file(1).md", f.body);
      expect(f.action([], "confirm", "current")).toBe(true);
      expect(f.action(["file.md"])).toEqual([true]);
    },
  );

  test("keeps the same form root as attachment regions and file inputs mount and unmount", () => {
    const f = currentComposerFixture(true);
    expect(f.action(["file.md"], "begin", "current")).toBe(true);
    const input = new FakeInputElement([]);
    f.body.append(input);
    f.addCurrentPreview("file(1).md", f.body);
    expect(f.action([], "confirm", "current")).toBe(true);
    input.remove();
    f.root.querySelector('input[type="file"]')!.remove();
    expect(f.action(["file.md"])).toEqual([true]);
  });

  test("rejects a changed explicit root even when the actual attachment control survives", () => {
    const f = currentComposerFixture();
    expect(f.action(["file.md"], "begin", "current")).toBe(true);
    f.addCurrentPreview("file(1).md", f.body);
    expect(f.action([], "confirm", "current")).toBe(true);
    const replacement = new FakeElement("form");
    f.body.remove();
    replacement.append(f.body);
    f.root.remove();
    f.document.body.append(replacement);
    expect(f.action(["file.md"])).toEqual([false]);
    expect(f.action([], "confirm", "current")).toBe(false);
  });

  test.each(["missing", "unknown", "hidden"])(
    "fails closed for a %s prompt even if send and attachment controls exist",
    (kind) => {
      const f = currentComposerFixture(true);
      if (kind === "hidden") f.prompt.getBoundingClientRect = () => ({ width: 0, height: 0 });
      else f.prompt.remove();
      if (kind === "unknown") f.body.append(new FakeElement("div", { role: "textbox" }));
      expect(f.action(["file.md"], "begin", "current")).toBe(false);
      f.addCurrentPreview("file.md", f.body);
      expect(f.action([], "confirm", "current")).toBe(false);
      expect(f.action(["file.md"])).toEqual([false]);
    },
  );

  test("preserves the legacy ancestor fallback for a recognized non-form composer", () => {
    const f = currentComposerFixture(true, "legacy");
    f.body.append(new FakeInputElement([]));
    expect(f.action(["file.md"], "begin", "current")).toBe(true);
    f.addCurrentPreview("file(1).md", f.body);
    expect(f.action([], "confirm", "current")).toBe(true);
    expect(f.action(["file.md"])).toEqual([true]);
  });

  test("prefers the unified-composer wrapper over an inner form when cards are siblings of the form", () => {
    const f = fixture();
    f.form.remove();
    const prompt = new FakeElement("div", {
      class: "ProseMirror",
      contenteditable: "true",
      role: "textbox",
      "data-composer-markdown": "true",
    });
    const footer = new FakeElement("div", { "data-testid": "composer-footer-actions" }, [
      prompt,
      new FakeElement("button", { "data-testid": "send-button" }),
    ]);
    const innerForm = new FakeElement("form", {}, [new FakeInputElement([]), footer]);
    const wrapper = new FakeElement("div", { "data-testid": "unified-composer" }, [innerForm]);
    f.document.body.append(wrapper);
    expect(f.action(["file.md"], "begin", "current")).toBe(true);
    f.addCurrentPreview("file(1).md", wrapper);
    expect(f.action([], "confirm", "current")).toBe(true);
    expect(f.action(["file.md"])).toEqual([true]);
    // Footer/action wrappers are never roots: a card inside one is still scoped to the wrapper.
    f.action(["second.md"], "begin", "second");
    f.addCurrentPreview("second.md", footer);
    expect(f.action([], "confirm", "second")).toBe(true);
    expect(f.action(["file.md", "second.md"])).toEqual([true, true]);
  });

  test.each([
    ["report  draft.md", "report  draft.md を削除", "report  draft(1).md を削除"],
    [" notes.md ", "notes.md を削除", "notes(2).md を削除"],
  ])("normalizes label whitespace before alias validation: %s", (original, initial, renamed) => {
    const f = fixture();
    f.action([original], "begin", "current");
    const control = f.addCurrentPreview(original, f.form, initial);
    expect(f.action([], "confirm", "current")).toBe(true);
    expect(f.action([original])).toEqual([true]);
    control.setAttribute("aria-label", renamed);
    expect(f.action([original])).toEqual([true]);
    expect(f.action([], "confirm", "current")).toBe(true);
    expect(f.evaluate(buildAttachmentReadyExpressionForTest([original]))).toBe(true);
  });

  test.each([
    "Remove attachment",
    "Remove file 1: first.md",
    "Remove file 1: added.md",
    "Remove file 1: upload.txt",
  ])("upload never uses %s as the add button", async (label) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const remove = new FakeElement("button", { "aria-label": label });
      const click = vi.fn();
      Object.assign(remove, { click, scrollIntoView: () => {} });
      f.form.append(remove);
      const input = { dispatchMouseEvent: vi.fn() };
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: expression.includes("location.href") ? f.evaluate(expression) : { input: true },
          },
        })),
      };
      const upload = uploadAttachmentFile(
        { runtime: runtime as never, dom: {} as never, input: input as never },
        { path: "/tmp/second.txt", displayPath: "second.txt" },
        () => {},
      );
      await vi.advanceTimersByTimeAsync(500);
      await expect(upload).resolves.toBe(true);
      expect(click).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("carries a filename-less assignment through visibility, completion, and send readiness", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect(f.action(["image.jpg"], "begin", "first")).toBe(true);
      f.addPreview();
      expect(f.action([], "confirm", "first")).toBe(true);
      expect(f.action(["image.jpg", "missing.txt"])).toEqual([true, false]);
      await waitForAttachmentVisible(f.runtime as never, "image.jpg", 500);
      const completion = waitForAttachmentCompletion(f.runtime as never, 3_000, ["image.jpg"]);
      await vi.advanceTimersByTimeAsync(2_500);
      await completion;
      expect(f.evaluate(buildAttachmentReadyExpressionForTest(["image.jpg"]))).toBe(true);
      expect(f.evaluate(buildAttachmentReadyExpressionForTest(["image.jpg", "missing.txt"]))).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("retains the same Japanese receipt when the provider collision-renames during upload", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const original = "report.md";
      f.action([original], "begin", "current");
      const control = f.addCurrentPreview(original);
      control.setAttribute("data-state", "uploading");
      expect(f.action([], "confirm", "current")).toBe(true);
      await waitForAttachmentVisible(f.runtime as never, original, 500);
      const completion = waitForAttachmentCompletion(f.runtime as never, 4_000, [original]);
      await vi.advanceTimersByTimeAsync(500);
      control.setAttribute("aria-label", "report(4).md を削除");
      expect(f.action([original])).toEqual([true]);
      expect(f.evaluate(buildAttachmentReadyExpressionForTest([original]))).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      control.setAttribute("data-state", "complete");
      expect(f.action([], "confirm", "current")).toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
      await completion;
      expect(f.evaluate(buildAttachmentReadyExpressionForTest([original]))).toBe(true);
      control.remove();
      f.addCurrentPreview("report(4).md");
      expect(f.action([original])).toEqual([false]);
      expect(f.evaluate(buildAttachmentReadyExpressionForTest([original]))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ["file.md", "file.md", "file(4).md", true],
    ["file.md", "file(1).md", "file (2-3).md", true],
    ["/folder/file.md", "file.md", "file(4).md", true],
    ["C:\\folder\\file.md", "file.md", "file(4).md", true],
    ["file(1).md", "file(1).md", "file(1)(4).md", true],
    ["file(1).md", "file(1).md", "file(4).md", false],
    ["file(1).md", "file(1).md", "file.md", false],
    ["a+[x].md", "a+[x].md", "a+[x](4).md", true],
    ["a+[x].md", "a+[x].md", "aaax(4).md", false],
    ["file.md", "file.md", "other(4).md", false],
    ["file.md", "file.md", "file(4).txt", false],
    ["file.md", "file.md", "prefix-file(4).md", false],
    ["file.md", "file.md", "file(4).md.bak", false],
    ["file.md", "file.md", "file(-4).md", false],
    ["file.md", "file.md", "file(4-).md", false],
    ["file.md", "other.md", "file(4).md", false],
    ["file.md", "other.md", "other(4).md", false],
    ["file", "file", "file(4)", true],
    ["file", "file", "file(4).md", false],
    ["Dockerfile", "Dockerfile", "Dockerfile (2-3)", true],
    ["Dockerfile", "Dockerfile", "Dockerfile.txt", false],
    [".env", ".env", ".env(4)", true],
    [".env", ".env", ".env(4).bak", false],
  ])(
    "validates Japanese collision labels against original %s: %s -> %s (%s)",
    (original, initial, renamed, accepted) => {
      const f = fixture();
      f.action([original], "begin", "current");
      const control = f.addCurrentPreview(initial);
      expect(f.action([], "confirm", "current")).toBe(true);
      control.setAttribute("aria-label", `${renamed} を削除`);
      expect(f.action([original])).toEqual([accepted]);
      expect(f.action([], "confirm", "current")).toBe(accepted);
    },
  );

  test("does not relax exact legacy English receipt labels", () => {
    const f = fixture();
    f.action(["file.md"], "begin", "current");
    const control = f.addPreview();
    control.setAttribute("aria-label", "Remove file 1: file.md");
    expect(f.action([], "confirm", "current")).toBe(true);
    control.setAttribute("aria-label", "Remove file 1: file(4).md");
    expect(f.action(["file.md"])).toEqual([false]);
  });

  test("never credits preexisting, outside-composer, or ambiguous Japanese cards", () => {
    const f = fixture();
    f.addCurrentPreview("existing.md");
    f.action(["new.md"], "begin", "current");
    f.addCurrentPreview("new.md", f.document.body);
    expect(f.action([], "confirm", "current")).toBe(false);
    f.addCurrentPreview("new(1).md");
    const second = f.addCurrentPreview("other.md");
    expect(f.action([], "confirm", "current")).toBe(false);
    second.remove();
    expect(f.action([], "confirm", "current")).toBe(true);
    f.action(["another.md"], "begin", "second");
    expect(f.action([], "confirm", "second")).toBe(false);
  });

  test("invalidates a Japanese receipt when its control loses geometry", () => {
    const f = fixture();
    f.action(["file.md"], "begin", "current");
    const control = f.addCurrentPreview("file(1).md");
    expect(f.action([], "confirm", "current")).toBe(true);
    control.getBoundingClientRect = () => ({ width: 0, height: 0 });
    expect(f.action(["file.md"])).toEqual([false]);
  });

  test("requires both current-card markers for Japanese controls", () => {
    for (const missing of ["card", "container"]) {
      const f = fixture();
      f.action(["file.md"], "begin", "current");
      const control = f.addCurrentPreview("file.md");
      if (missing === "card") control.parentElement!.setAttribute("class", "");
      if (missing === "container") {
        const card = control.parentElement!;
        card.remove();
        f.form.append(card);
      }
      expect(f.action([], "confirm", "current")).toBe(false);
    }
  });

  test.each(["inconnu.md supprimer", "unknown.md", "を削除", " を削除"])(
    "does not treat an unknown card label %s as a removal control",
    (label) => {
      const f = fixture();
      f.action(["file.md"], "begin", "current");
      f.addCurrentPreview("file.md", f.form, label);
      expect(f.action([], "confirm", "current")).toBe(false);
    },
  );

  test("rejects unscoped Japanese buttons, editable content, card containers, and assigned FileLists", () => {
    const f = fixture();
    f.action(["file.md"], "begin", "current");
    f.form.append(new FakeElement("button", { "aria-label": "file.md を削除" }));
    f.form.append(new FakeInputElement([{ name: "file.md" }]));
    const editable = new FakeElement("div", { contenteditable: "true" });
    f.form.append(editable);
    f.addCurrentPreview("file.md", editable);
    const card = f.addCurrentPreview("file.md");
    card.remove();
    expect(f.action([], "confirm", "current")).toBe(false);
    expect(f.action(["file.md"])).toEqual([false]);
  });

  test("recognizes the signed-in image tile by its exact removal label", async () => {
    const f = fixture();
    f.form.append(
      new FakeElement("div", {}, [
        new FakeElement("button", {
          "aria-label": "Remove file 1: signed-in-image.png",
        }),
      ]),
    );

    await expect(
      waitForAttachmentVisible(f.runtime as never, "signed-in-image.png", 500),
    ).resolves.toBeUndefined();

    const expressions = f.runtime.evaluate.mock.calls.map(([call]) => call.expression);
    expect(expressions.some((expression) => expression.includes('[aria-label*="Remove" i]'))).toBe(
      true,
    );
  });

  test("never credits a pre-existing or sidebar control to an assignment", () => {
    const f = fixture();
    f.addPreview();
    f.action(["image.jpg"], "begin", "first");
    f.addPreview(f.document.body);
    expect(f.action([], "confirm", "first")).toBe(false);
    expect(f.action(["image.jpg"])).toEqual([false]);
  });

  test("rejects ambiguous additions and never spends one control on two files", () => {
    const f = fixture();
    f.action(["one.jpg"], "begin", "first");
    const one = f.addPreview();
    const other = f.addPreview();
    expect(f.action([], "confirm", "first")).toBe(false);
    other.remove();
    expect(f.action([], "confirm", "first")).toBe(true);
    f.action(["two.jpg"], "begin", "second");
    expect(f.action([], "confirm", "second")).toBe(false);
    one.remove();
    f.addPreview();
    expect(f.action(["one.jpg"])).toEqual([false]);
  });

  test("a removed/replaced attachment, a new composer, and explicit clear invalidate evidence", () => {
    const f = fixture();
    f.action(["image.jpg"], "begin", "first");
    const control = f.addPreview();
    f.action([], "confirm", "first");
    control.remove();
    f.addPreview();
    expect(f.action(["image.jpg"])).toEqual([false]);
    f.action(["image.jpg"], "begin", "second");
    f.addPreview();
    f.action([], "confirm", "second");
    expect(f.action(["image.jpg"])).toEqual([true]);
    f.action([], "clear");
    expect(f.action(["image.jpg"])).toEqual([false]);
    f.action(["image.jpg"], "begin", "third");
    f.addPreview();
    f.action([], "confirm", "third");
    f.form.remove();
    expect(f.action(["image.jpg"])).toEqual([false]);
  });
});
