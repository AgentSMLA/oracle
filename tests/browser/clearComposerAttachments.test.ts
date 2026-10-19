import { afterEach, describe, expect, test, vi } from "vitest";
import { clearComposerAttachments } from "../../src/browser/actions/attachments.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

type ClickableElement = FakeElement & { click?: () => void };

function fixture() {
  const form = new FakeElement("form", { "data-chatgpt-composer": "" }, [
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
      "HTMLButtonElement",
      "window",
      "globalThis",
      "location",
      `return ${expression};`,
    )(
      document,
      FakeElement,
      FakeInputElement,
      FakeElement,
      { getComputedStyle: () => ({ pointerEvents: "auto" }) },
      renderer,
      new URL("https://chatgpt.com/"),
    );
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression) },
    })),
  };
  // Current ChatGPT Japanese card: no test ID, hover-only removal button inside
  // [data-composer-attachments] > ... > [class~="group/composer-attachment"].
  const addJapaneseCard = (name: string, parent = form, removeOnClick = true) => {
    const control: ClickableElement = new FakeElement("button", {
      type: "button",
      "aria-label": `${name} を削除`,
      class: "opacity-0 pointer-events-none group-hover/composer-attachment:opacity-100",
    });
    const wrapper = new FakeElement(
      "div",
      { "data-composer-attachments": "", "data-visible-attachments": "" },
      [
        new FakeElement("div", {}, [
          new FakeElement("span", { class: "group/composer-attachment" }, [
            new FakeElement("span", {}, [
              new FakeElement("span", { class: "truncate" }, [], name),
              new FakeElement("button", { type: "button", "aria-label": name }),
            ]),
            control,
          ]),
        ]),
      ],
    );
    control.click = vi.fn(() => {
      if (removeOnClick) wrapper.remove();
    });
    parent.append(wrapper);
    return { control, wrapper };
  };
  const addEnglishChip = (parent = form) => {
    const control: ClickableElement = new FakeElement("button", { "aria-label": "Remove file" });
    const chip = new FakeElement("div", { "data-testid": "attachment-chip" }, [control]);
    control.click = vi.fn(() => chip.remove());
    parent.append(chip);
    return { control, chip };
  };
  const addUnscopedJapaneseButton = (label: string, parent: FakeElement) => {
    const control: ClickableElement = new FakeElement("button", {
      type: "button",
      "aria-label": label,
    });
    control.click = vi.fn();
    parent.append(control);
    return control;
  };
  return { form, document, runtime, addJapaneseCard, addEnglishChip, addUnscopedJapaneseButton };
}

describe("clearComposerAttachments", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("removes a stale Japanese attachment card left in a reused composer", async () => {
    const f = fixture();
    const { control, wrapper } = f.addJapaneseCard("stale.md");
    await expect(clearComposerAttachments(f.runtime as never, 1_000)).resolves.toBeUndefined();
    expect(control.click).toHaveBeenCalledTimes(1);
    expect(wrapper.isConnected).toBe(false);
    expect(f.document.querySelector("[data-composer-attachments]")).toBeNull();
  });

  test("still removes a legacy English 'Remove file' chip", async () => {
    const f = fixture();
    const { control, chip } = f.addEnglishChip();
    await expect(clearComposerAttachments(f.runtime as never, 1_000)).resolves.toBeUndefined();
    expect(control.click).toHaveBeenCalledTimes(1);
    expect(chip.isConnected).toBe(false);
  });

  test.each(["Japanese", "English"])(
    "clears a legacy %s card beside the single composer form",
    async (locale) => {
      const f = fixture();
      f.form.remove();
      const wrapper = new FakeElement("div", {}, [f.form]);
      f.document.body.append(wrapper);
      const card =
        locale === "Japanese" ? f.addJapaneseCard("stale.md", wrapper) : f.addEnglishChip(wrapper);
      await expect(clearComposerAttachments(f.runtime as never, 1_000)).resolves.toBeUndefined();
      expect(card.control.click).toHaveBeenCalledTimes(1);
      expect(card.control.isConnected).toBe(false);
    },
  );

  test.each(["Japanese", "English"])(
    "does not clear a sibling composer's %s file",
    async (locale) => {
      const f = fixture();
      const sibling = new FakeElement("form", { "data-testid": "composer" }, [
        new FakeElement("textarea"),
        new FakeElement("button", { "data-testid": "send-button" }),
      ]);
      f.form.remove();
      f.document.body.append(new FakeElement("div", {}, [f.form, sibling]));
      const active = f.addJapaneseCard("active.md");
      const other =
        locale === "Japanese" ? f.addJapaneseCard("other.md", sibling) : f.addEnglishChip(sibling);
      await expect(clearComposerAttachments(f.runtime as never, 1_000)).resolves.toBeUndefined();
      expect(active.control.click).toHaveBeenCalledTimes(1);
      expect(other.control.click).not.toHaveBeenCalled();
      expect(other.control.isConnected).toBe(true);
    },
  );

  test("ignores Japanese 削除 buttons outside the attachment card markers", async () => {
    const f = fixture();
    const sidebar = f.addUnscopedJapaneseButton("履歴 を削除", f.document.body);
    const inForm = f.addUnscopedJapaneseButton("下書き を削除", f.form);
    const bareWrapper = new FakeElement("div", { "data-composer-attachments": "" });
    f.form.append(bareWrapper);
    const noGroup = f.addUnscopedJapaneseButton("file.md を削除", bareWrapper);
    await expect(clearComposerAttachments(f.runtime as never, 1_000)).resolves.toBeUndefined();
    expect(sidebar.click).not.toHaveBeenCalled();
    expect(inForm.click).not.toHaveBeenCalled();
    expect(noGroup.click).not.toHaveBeenCalled();
  });

  test("fails closed when a Japanese card survives its removal click", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const logger = vi.fn();
    const { control, wrapper } = f.addJapaneseCard("sticky.md", f.form, false);
    const promise = clearComposerAttachments(f.runtime as never, 1_000, logger);
    const settled = expect(promise).rejects.toThrow(/Existing attachments still present/);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(control.click).toHaveBeenCalled();
    expect(wrapper.isConnected).toBe(true);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Attachment cleanup timed out"));
  });
});
