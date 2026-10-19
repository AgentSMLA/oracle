// Executes the generated probe/boundary/delivery expressions against a fake DOM.
import { expect, test, vi } from "vitest";
import { __test__ as composer } from "../../src/browser/actions/promptComposer.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

function fixture(label = "送信", attributes: Record<string, string> = {}, inForm = true) {
  const button = new FakeElement("button", { type: "submit", "aria-label": label, ...attributes });
  const form = new FakeElement("form", { "data-chatgpt-composer": "" }, [
    new FakeElement("textarea", { id: "prompt-textarea" }),
    new FakeElement("button", { "aria-label": "Remove file.md" }),
    ...(inForm ? [button] : []),
  ]);
  const document = Object.assign(new FakeDocument([form, ...(inForm ? [] : [button])]), {
    activeElement: null as FakeElement | null,
  });
  Object.assign(button, {
    focus: () => {
      document.activeElement = button;
    },
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    getComputedStyle: () => ({ pointerEvents: "auto", display: "block", visibility: "visible" }),
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const renderer = {};
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function(
          "document",
          "HTMLElement",
          "HTMLInputElement",
          "window",
          "globalThis",
          "location",
          "Node",
          "Element",
          `return ${expression};`,
        )(
          document,
          FakeElement,
          FakeInputElement,
          window,
          renderer,
          new URL("https://chatgpt.com/"),
          FakeElement,
          FakeElement,
        ),
      },
    })),
  };
  const input = {
    dispatchKeyEvent: vi.fn(async ({ type, key }: { type: string; key: string }) => {
      listeners.get(type.toLowerCase())?.({
        key,
        isTrusted: true,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      });
    }),
  };
  const activate = () =>
    composer.activateExactAttachmentSendButton(
      runtime as never,
      input as never,
      undefined,
      "https://chatgpt.com/",
      ["file.md"],
    );
  return { activate, input, document, form, button, runtime, listeners };
}

test.each(["送信", "Send"])(
  "ignores an unrelated %s submit before the active composer",
  async (label) => {
    const f = fixture(label);
    const other = new FakeElement("button", { type: "submit", "aria-label": label });
    const focus = vi.fn(() => {
      f.document.activeElement = other;
    });
    Object.assign(other, { focus });
    f.form.remove();
    f.document.body.append(new FakeElement("form", {}, [other]));
    f.document.body.append(f.form);
    expect(await f.activate()).toBe(true);
    expect(f.document.activeElement).toBe(f.button);
    expect(focus).not.toHaveBeenCalled();
  },
);

test("activates the Japanese exact form submit through real probe, boundary and delivery expressions", async () => {
  const f = fixture();
  expect(await f.activate()).toBe(true);
  expect(f.document.activeElement).toBe(f.button);
  expect(f.input.dispatchKeyEvent.mock.calls.map(([event]) => event.type)).toEqual([
    "keyDown",
    "keyUp",
  ]);
  expect(f.runtime.evaluate).toHaveBeenCalledTimes(3);
  expect(f.listeners.size).toBe(0);
});

test.each<{ label: string; attributes: Record<string, string>; inForm: boolean }>([
  { label: "送信", attributes: { disabled: "" }, inForm: true },
  { label: "送信", attributes: { "aria-disabled": "true" }, inForm: true },
  { label: "送信", attributes: { "data-disabled": "true" }, inForm: true },
  { label: "送信する", attributes: {}, inForm: true },
  { label: "削除", attributes: {}, inForm: true },
  { label: "", attributes: {}, inForm: true },
  { label: "送信", attributes: {}, inForm: false },
])(
  "does not dispatch for non-allowlisted or disabled control %j",
  async ({ label, attributes, inForm }) => {
    const f = fixture(label, attributes, inForm);
    expect(await f.activate()).toBe(false);
    expect(f.input.dispatchKeyEvent).not.toHaveBeenCalled();
  },
);
