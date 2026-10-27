import { z } from "zod";

export const choicesSchema = z.array(
  z.object({ code: z.string(), title: z.string(), selector: z.string(), disabled: z.boolean() }),
);
export const selectionSchema = z.object({
  model: z.string().min(1),
  thinking: z.string().nullable(),
});
export const completionSchema = z.object({ text: z.string().min(1), url: z.string() });

type Operation =
  | { kind: "ready" | "models" | "thinking" | "selection" | "close-present" }
  | { kind: "closed"; selector: string }
  | { kind: "mark"; token: string }
  | { kind: "send"; model: string; thinking: string | null; prompt: string }
  | { kind: "turn"; token: string; prompt: string };

/** Serialized into the owned tab; waits subscribe before checking and release both resources. */
export function aiStudioDom(operation: Operation, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const visible = (node: Element): boolean =>
      node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const nodes = (selector: string, root: ParentNode = document): Element[] =>
      Array.from(root.querySelectorAll(selector)).filter(visible);
    const text = (node: Element | null | undefined): string => (node?.textContent ?? "").trim();
    const disabled = (node: Element): boolean =>
      node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true";
    const selected = (): z.infer<typeof selectionSchema> => ({
      model: text(document.querySelector('button.model-selector-card [data-test-id="model-name"]')),
      thinking:
        text(
          document.querySelector('[role="combobox"][aria-label="Thinking Level"]'),
        ).toLowerCase() || null,
    });
    let settled = false;
    const finish = (value: unknown, error?: Error): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const check = (): void => {
      try {
        if (location.hostname !== "aistudio.google.com")
          throw new Error(`AI Studio unavailable at ${location.origin}. Sign-in is not automated.`);
        const failure = nodes('[role="alert"], .error-message, .refusal-message').find(
          (node) => text(node).length > 0,
        );
        const dialog = nodes('[role="dialog"], [role="alertdialog"]').find(
          (node) =>
            !node.querySelector('button[id^="model-carousel-row-models/"]') &&
            !node.querySelector('[role="listbox"][aria-label="Thinking Level"]'),
        );
        if (failure || dialog)
          throw new Error(`AI Studio requires attention: ${text(failure ?? dialog)}`);
        switch (operation.kind) {
          case "ready":
            if (
              nodes('textarea[aria-label="Enter a prompt"]').length &&
              nodes("button.model-selector-card").some((node) => !disabled(node))
            )
              finish(true);
            break;
          case "models": {
            const rows = nodes('button[id^="model-carousel-row-models/"]');
            if (rows.length)
              finish(
                rows.map((node) => ({
                  code: (node.getAttribute("id") ?? "").slice("model-carousel-row-models/".length),
                  title: text(node.querySelector(".model-title-text")),
                  selector: `[id=${JSON.stringify(node.getAttribute("id"))}]`,
                  disabled: disabled(node),
                })),
              );
            break;
          }
          case "thinking": {
            const options = nodes('[role="option"]');
            if (options.length)
              finish(
                options.map((node, index) => {
                  node.setAttribute("data-oracle-ai-option", String(index));
                  return {
                    code: text(node).toLowerCase(),
                    title: text(node),
                    selector: `[data-oracle-ai-option="${index}"]`,
                    disabled: disabled(node),
                  };
                }),
              );
            break;
          }
          case "selection":
            finish(selected());
            break;
          case "close-present":
            finish(nodes('button[aria-label="Close panel"]').length > 0);
            break;
          case "closed":
            // Presence, not visibility: do not click through a closing overlay.
            if (!document.querySelector(operation.selector)) finish(true);
            break;
          case "mark":
            for (const turn of document.querySelectorAll("ms-chat-turn"))
              turn.setAttribute("data-oracle-ai-before", operation.token);
            finish(true);
            break;
          case "send": {
            const actual = selected();
            if (actual.model !== operation.model || actual.thinking !== operation.thinking)
              throw new Error(
                "AI Studio selection changed before submission. No prompt was submitted.",
              );
            const editor = document.querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Enter a prompt"]',
            );
            if (editor?.value !== operation.prompt)
              throw new Error("AI Studio staged prompt does not match. No prompt was submitted.");
            const button = nodes("button.ctrl-enter-submits")[0];
            if (
              button &&
              !disabled(button) &&
              text(button.querySelector(".run-button-label")) === "Run"
            )
              finish(true);
            break;
          }
          case "turn": {
            const fresh = nodes("ms-chat-turn").filter(
              (turn) => turn.getAttribute("data-oracle-ai-before") !== operation.token,
            );
            const userIndex = fresh.findIndex(
              (turn) =>
                nodes(
                  '.user-prompt-container[data-turn-role="User"] ms-prompt-chunk ms-text-chunk',
                  turn,
                )
                  .map((node) => node.textContent ?? "")
                  .join("\n\n")
                  .trim() === operation.prompt,
            );
            if (userIndex < 0) break;
            let model: Element | undefined;
            for (const turn of fresh.slice(userIndex + 1)) {
              if (turn.querySelector(".chat-turn-container.user")) break;
              if (turn.querySelector(".chat-turn-container.model")) {
                model = turn;
                break;
              }
            }
            const chunks = model
              ? nodes(
                  '.model-prompt-container[data-turn-role="Model"] ms-prompt-chunk ms-text-chunk',
                  model,
                )
              : [];
            const content = chunks
              .map(
                (node) =>
                  (node instanceof HTMLElement ? node.innerText : undefined) ??
                  node.textContent ??
                  "",
              )
              .join("\n\n")
              .trim();
            const run = nodes("button.ctrl-enter-submits .run-button-label")[0];
            if (content && text(run) === "Run") finish({ text: content, url: location.href });
            break;
          }
        }
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(
      () => finish(undefined, new Error(`AI Studio ${operation.kind} timed out.`)),
      timeoutMs,
    );
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}

export function domExpression(operation: Operation, timeoutMs: number): string {
  return `(${aiStudioDom.toString()})(${JSON.stringify(operation)}, ${timeoutMs})`;
}
