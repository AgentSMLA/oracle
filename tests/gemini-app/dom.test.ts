import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { z } from "zod";
import { domExpression, itemsSchema, turnSchema } from "../../src/gemini-app/dom.js";
import { FixtureElement as Element, fixtureDom } from "./fixtureDom.js";

const token = "fixture-token";
const prompt = "PROMPT_SENTINEL";
const query = (): Element =>
  new Element("user-query").append(new Element("user-query-content", prompt));
const footer = (): Element => new Element("div", "", { class: "response-footer complete" });
const response = (value: string): Element =>
  new Element("model-response").append(new Element("message-content", value));
const captured = z
  .object({
    responseClass: z.string(),
    processingClass: z.string(),
    markdownClass: z.string(),
    busyState: z.string(),
    footerClass: z.string(),
    outerFooterClass: z.string(),
    actionLabel: z.string(),
    token: z.string(),
  })
  .parse(
    JSON.parse(
      await fs.readFile(new URL("./fixtures/text-completion.json", import.meta.url), "utf8"),
    ),
  );
function capturedResponse(): Element {
  return new Element("model-response", "", { class: captured.responseClass }).append(
    new Element("response-container").append(
      new Element("structured-content-container", "", { class: captured.processingClass }).append(
        new Element("message-content").append(
          new Element("div", captured.token, {
            class: captured.markdownClass,
            "aria-busy": captured.busyState,
          }),
        ),
      ),
      new Element("div", "", { class: captured.footerClass }),
      new Element("div", "ACTIONS_SENTINEL", { class: captured.outerFooterClass }).append(
        new Element("button", "", { "aria-label": captured.actionLabel }),
      ),
    ),
  );
}

describe("Gemini mutation-observer DOM protocol", () => {
  it("waits for enabled model and tools controls after the editor appears", async () => {
    const dom = fixtureDom();
    dom.root.append(
      new Element("rich-textarea").append(
        new Element("div", "", { class: "ql-editor", contenteditable: "true" }),
      ),
    );
    const pending = dom.evaluate(domExpression({ kind: "ready" }, 500));
    expect(dom.observers()).toBe(1);
    const picker = new Element("button", "", {
      "data-test-id": "bard-mode-menu-button",
      disabled: "",
    });
    dom.mutate(() => dom.root.append(picker));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => {
      picker.attributes.delete("disabled");
      dom.root.append(new Element("button", "", { class: "toolbox-drawer-button" }));
    });
    expect(await pending).toBe(true);
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("selects only a visible enabled native send button with the exact staged prompt", async () => {
    // Given
    const dom = fixtureDom();
    dom.root.append(
      new Element("rich-textarea").append(
        new Element("div", prompt, { class: "ql-editor", contenteditable: "true" }),
      ),
    );
    const button = new Element("button", "", { "aria-label": "傳送訊息", disabled: "" });
    dom.root.append(
      button,
      new Element("button", "Argon", { "data-test-id": "bard-mode-menu-button" }),
    );
    // When
    const pending = dom.evaluate(domExpression({ kind: "send", token, prompt, mode: "chat" }, 500));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => button.attributes.delete("disabled"));
    // Then
    expect(await pending).toEqual({
      selector: `[data-oracle-gemini-control="send-${token}"]`,
      modelButtonText: "Argon",
    });
    expect(dom.observers()).toBe(0);
  });

  it("extracts the actual captured message while excluding surrounding response controls", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(query(), capturedResponse());
    // When
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression({ kind: "turn", token, prompt, mode: "chat", approved: false }, 500),
      ),
    );
    // Then
    expect(result.phase).toBe("complete");
    expect(result.text).toBe(captured.token);
  });

  it("waits for the captured Markdown busy state even when the footer is complete", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    const fresh = capturedResponse();
    const markdown = fresh.querySelector(".markdown");
    markdown?.setAttribute("aria-busy", "true");
    dom.root.append(query(), fresh);
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "chat", approved: false }, 500),
    );
    expect(dom.observers()).toBe(1);
    dom.mutate(() => markdown?.setAttribute("aria-busy", "false"));
    // Then
    expect(turnSchema.parse(await pending).text).toBe(captured.token);
  });

  it("never substitutes response controls for absent message content", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(query(), new Element("model-response", "ACTIONS_SENTINEL").append(footer()));
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "chat", approved: false }, 500),
    );
    const rejection = expect(pending).rejects.toThrow("timed out");
    dom.expire();
    // Then
    await rejection;
  });

  it("fails a completed ordinary answer requested as Deep Research", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(query(), capturedResponse());
    // When
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression({ kind: "turn", token, prompt, mode: "deep-research", approved: false }, 500),
      ),
    );
    // Then
    expect(result.phase).toBe("failed");
    expect(result.text).toBe(captured.token);
    expect(result.citations).toEqual([]);
  });

  it("fails the captured completed Argon image refusal immediately and preserves its reply", async () => {
    // Given
    const refusal = z
      .object({ text: z.string(), footerClass: z.string(), busyState: z.string() })
      .parse(
        JSON.parse(
          await fs.readFile(new URL("./fixtures/image-refusal.json", import.meta.url), "utf8"),
        ),
      );
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(
      query(),
      new Element("model-response").append(
        new Element("message-content").append(
          new Element("div", refusal.text, {
            class: "markdown",
            "aria-busy": refusal.busyState,
          }),
        ),
        new Element("div", "", { class: refusal.footerClass }),
      ),
    );
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "image", approved: false }, 500),
    );
    // Then: settlement occurs in the immediate state check, not at a media timeout.
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
    const result = turnSchema.parse(await pending);
    expect(result.phase).toBe("failed");
    expect(result.text).toBe(refusal.text);
    expect(result.control).toBeNull();
  });

  it("captures the actual reply when the live quota-reset banner appears", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(
      query(),
      capturedResponse(),
      new Element("div", "額度將於 7:40 下午 重設").append(new Element("button", "查看用量")),
    );
    // When
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression({ kind: "turn", token, prompt, mode: "deep-research", approved: false }, 500),
      ),
    );
    // Then
    expect(result.phase).toBe("failed");
    expect(result.text).toBe(captured.token);
  });

  it("detects a post-submit model fallback rather than returning ordinary text as success", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(
      query(),
      capturedResponse(),
      new Element("button", "Flash-Lite", { "data-test-id": "bard-mode-menu-button" }),
    );
    // When
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression(
          { kind: "turn", token, prompt, mode: "chat", approved: false, modelButtonText: "Pro" },
          500,
        ),
      ),
    );
    // Then
    expect(result.phase).toBe("failed");
    expect(result.text).toBe(captured.token);
  });

  it("verifies acceptance only after a matching fresh user turn appears", async () => {
    // Given
    const dom = fixtureDom();
    dom.root.append(query());
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    // When
    const pending = dom.evaluate(domExpression({ kind: "accepted", token, prompt }, 500));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => dom.root.append(query()));
    // Then
    expect(await pending).toBe(true);
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("ignores old completed replies and waits for the newly submitted turn to finish", async () => {
    // Given
    const dom = fixtureDom();
    dom.root.append(query(), response("OLD_REPLY").append(footer()));
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "chat", approved: false }, 500),
    );
    expect(dom.observers()).toBe(1);
    const fresh = response("FRESH_REPLY");
    dom.mutate(() => dom.root.append(query(), fresh));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => fresh.append(footer()));
    const result = turnSchema.parse(await pending);
    // Then
    expect(result.text).toBe("FRESH_REPLY");
    expect(result.phase).toBe("complete");
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("does not use an old response even if the old prompt text matches", async () => {
    // Given
    const dom = fixtureDom();
    dom.root.append(query(), response("OLD_REPLY").append(footer()));
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "chat", approved: false }, 500),
    );
    const rejected = expect(pending).rejects.toThrow("timed out");
    dom.expire();
    // Then
    await rejected;
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("recognizes a research plan but never treats its complete footer as a finished report", async () => {
    // Given
    const dom = fixtureDom();
    const oldReport = new Element("deep-research-report", "OLD_REPORT", {
      "data-status": "complete",
    }).append(new Element("a", "Old", { href: "https://example.test/old" }));
    dom.root.append(oldReport);
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    const planButton = new Element("button", "Start research");
    const planResponse = response("PLAN_SENTINEL").append(planButton, footer());
    dom.root.append(query(), planResponse);
    // When
    const plan = turnSchema.parse(
      await dom.evaluate(
        domExpression({ kind: "turn", token, prompt, mode: "deep-research", approved: false }, 500),
      ),
    );
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "deep-research", approved: true }, 500),
    );
    const report = new Element("deep-research-report", "REPORT_SENTINEL").append(
      new Element("a", "Source", { href: "https://example.test/source" }),
    );
    dom.mutate(() => dom.root.append(report));
    expect(dom.observers()).toBe(1);
    dom.mutate(() => report.setAttribute("data-status", "complete"));
    const result = turnSchema.parse(await pending);
    // Then
    expect(plan.phase).toBe("plan");
    expect(plan.control).toBe(`[data-oracle-gemini-control="${token}"]`);
    expect(result.phase).toBe("complete");
    expect(result.text).toContain("REPORT_SENTINEL");
    expect(result.citations).toEqual([{ title: "Source", url: "https://example.test/source" }]);
    expect(dom.observers()).toBe(0);
  });

  it("fails a fresh provider limit rather than accepting the footer", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(query(), response("You have reached your daily limit").append(footer()));
    // When / Then
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression({ kind: "turn", token, prompt, mode: "video", approved: false }, 500),
      ),
    );
    expect(result.phase).toBe("failed");
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("returns only a fresh decoded generated-image capture target", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    const download = new Element("button", "", {
      "aria-label": "Download full size image",
      disabled: "",
    });
    const image = new Element("img", "", {
      src: "blob:fixture",
      alt: " (由 AI 生成)",
      class: "image animate loaded",
    });
    image.complete = false;
    dom.root.append(query(), response("MEDIA_SENTINEL").append(image, download, footer()));
    // When
    const pending = dom.evaluate(
      domExpression({ kind: "turn", token, prompt, mode: "image", approved: false }, 500),
    );
    expect(dom.observers()).toBe(1);
    dom.mutate(() => {
      image.complete = true;
    });
    const result = turnSchema.parse(await pending);
    // Then
    expect(result.control).toBe(`[data-oracle-gemini-control="${token}"]`);
    expect(dom.observers()).toBe(0);
  });

  it("accepts the captured Pro generated image without message text or a model fallback", async () => {
    // Given
    const dom = fixtureDom();
    await dom.evaluate(domExpression({ kind: "mark", token }, 500));
    dom.root.append(
      query(),
      new Element("model-response").append(
        new Element("img", "", {
          src: "blob:fixture",
          alt: " (由 AI 生成)",
          class: "image animate loaded",
        }),
        new Element("button", "", { "aria-label": "下載原尺寸圖片" }),
        footer(),
      ),
      new Element("button", "Pro", { "data-test-id": "bard-mode-menu-button" }),
    );
    // When
    const result = turnSchema.parse(
      await dom.evaluate(
        domExpression(
          { kind: "turn", token, prompt, mode: "image", approved: false, modelButtonText: "Pro" },
          500,
        ),
      ),
    );
    // Then
    expect(result.phase).toBe("complete");
    expect(result.text).toBe("");
    expect(result.control).toBe(`[data-oracle-gemini-control="${token}"]`);
    expect(dom.observers()).toBe(0);
    expect(dom.timers()).toBe(0);
  });

  it("reads selected-class model evidence and excludes hidden options", async () => {
    // Given
    const dom = fixtureDom();
    const selected = new Element("gem-menu-item", "", {
      role: "menuitem",
      "data-mode-id": "future",
      class: "selected",
    }).append(new Element("span", "Future Exact Label", { class: "label" }));
    const hidden = new Element("gem-menu-item", "Hidden", {
      role: "menuitem",
      "data-mode-id": "hidden",
    });
    hidden.hidden = true;
    dom.root.append(selected, hidden);
    // When
    const result = itemsSchema.parse(await dom.evaluate(domExpression({ kind: "models" }, 500)));
    // Then
    expect(result).toEqual([
      {
        label: "Future Exact Label",
        selector: '[data-oracle-gemini-control="model-0"]',
        selected: true,
        disabled: false,
      },
    ]);
    expect(dom.observers()).toBe(0);
  });
});
