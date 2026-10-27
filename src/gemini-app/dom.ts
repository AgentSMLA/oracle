import { z } from "zod";

export const itemSchema = z.object({
  label: z.string(),
  selector: z.string(),
  selected: z.boolean(),
  disabled: z.boolean(),
});
export const itemsSchema = z.array(itemSchema);
export const turnSchema = z.object({
  phase: z.enum(["plan", "complete", "failed"]),
  text: z.string(),
  url: z.string(),
  control: z.string().nullable(),
  citations: z.array(z.object({ title: z.string(), url: z.string() })),
  failure: z.string().optional(),
});
export const sendSchema = z.object({
  selector: z.string().min(1),
  modelButtonText: z.string().min(1),
});
export const mediaCaptureSchema = z.object({
  dataUrl: z
    .string()
    .regex(/^data:(?:image\/png|(?:video|audio)\/[\w.+-]+);base64,[A-Za-z0-9+/]+={0,2}$/),
  mimeType: z.string(),
  byteLength: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

type DomOperation =
  | { readonly kind: "ready" }
  | { readonly kind: "models" }
  | { readonly kind: "thinking" }
  | { readonly kind: "tools" }
  | { readonly kind: "mark"; readonly token: string }
  | {
      readonly kind: "send";
      readonly token: string;
      readonly prompt: string;
      readonly mode: string;
    }
  | { readonly kind: "accepted"; readonly token: string; readonly prompt: string }
  | {
      readonly kind: "turn";
      readonly token: string;
      readonly prompt: string;
      readonly mode: string;
      readonly approved: boolean;
      readonly modelButtonText?: string;
    };

/**
 * Serialized into the owned tab. Every wait subscribes before checking, and its
 * observer/timer is released on success, failure, timeout, or session teardown.
 */
export function geminiDom(operation: DomOperation, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const visible = (element: Element): boolean =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const elements = (selector: string, root: ParentNode = document): Element[] =>
      Array.from(root.querySelectorAll(selector)).filter(visible);
    const text = (element: Element | undefined | null): string =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    const disabled = (element: Element): boolean =>
      element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
    const label = (element: Element): string => {
      const named = element.querySelector(".label, .mode-title, .model-name");
      if (named) return text(named);
      const copy = element.cloneNode(true);
      if (!(copy instanceof Element)) return text(element);
      for (const icon of copy.querySelectorAll("gem-icon, mat-icon, .description, .subtitle"))
        icon.remove();
      return text(copy);
    };
    const control = (element: Element, value: string): string => {
      element.setAttribute("data-oracle-gemini-control", value);
      return `[data-oracle-gemini-control="${value}"]`;
    };
    const selected = (element: Element): boolean =>
      element.classList.contains("selected") || element.getAttribute("aria-checked") === "true";
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const quotaNotice = (): string => {
      const notices = elements('[role="alert"]').map(text);
      const usage = elements("button, [role='button']").find((element) =>
        /^(?:查看用量|View usage)$/i.test(element.getAttribute("aria-label") || text(element)),
      );
      let ancestor = usage?.parentElement;
      for (let depth = 0; ancestor && depth < 4; depth += 1) {
        notices.push(text(ancestor));
        ancestor = ancestor.parentElement;
      }
      return (
        notices.find((notice) =>
          /額度將於.*重設|(?:quota|limit).*(?:reset|reached)/i.test(notice),
        ) ?? ""
      );
    };
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
        if (location.hostname !== "gemini.google.com") {
          throw new Error(`Gemini signed-in application unavailable at ${location.origin}.`);
        }
        switch (operation.kind) {
          case "ready": {
            if (
              elements('rich-textarea .ql-editor[contenteditable="true"]').length &&
              elements('[data-test-id="bard-mode-menu-button"]').some(
                (element) => !disabled(element),
              ) &&
              elements(
                'button.toolbox-drawer-button, button[aria-label="上傳與工具"], button[aria-label="Tools"]',
              ).some((element) => !disabled(element))
            )
              finish(true);
            break;
          }
          case "models": {
            const options = elements('gem-menu-item[role="menuitem"][data-mode-id]');
            if (options.length)
              finish(
                options.map((element, index) => ({
                  label: label(element),
                  selector: control(element, `model-${index}`),
                  selected: selected(element),
                  disabled: disabled(element),
                })),
              );
            break;
          }
          case "thinking": {
            const opener = elements('gem-menu-item[value="thinking_level"]')[0];
            const id = opener?.getAttribute("aria-controls");
            const menu = id ? document.getElementById(id) : null;
            const options = menu
              ? elements('gem-menu-item[role="menuitem"], gem-menu-item', menu)
              : [];
            if (options.length)
              finish(
                options.map((element, index) => ({
                  label: label(element),
                  selector: control(element, `thinking-${index}`),
                  selected: selected(element),
                  disabled: disabled(element),
                })),
              );
            break;
          }
          case "tools": {
            const options = elements('[role="menuitemcheckbox"].toolbox-drawer-item-list-button');
            if (options.length)
              finish(
                options.map((element, index) => ({
                  label: label(element),
                  selector: control(element, `tool-${index}`),
                  selected: selected(element),
                  disabled: disabled(element),
                })),
              );
            break;
          }
          case "mark": {
            for (const element of document.querySelectorAll(
              "model-response, user-query, deep-research-report, .research-report, [data-test-id='research-report']",
            )) {
              element.setAttribute("data-oracle-gemini-before", operation.token);
            }
            finish(true);
            break;
          }
          case "send": {
            const editor = elements('rich-textarea .ql-editor[contenteditable="true"]')[0];
            if (!editor || normalize(text(editor)) !== normalize(operation.prompt))
              throw new Error("Gemini composer does not contain this run's exact prompt.");
            const quota = quotaNotice();
            if (quota) throw new Error(`Gemini quota notice before dispatch: ${quota}`);
            const chips = elements(
              '.toolbox-drawer-item-deselect-button, button[aria-label^="取消選取"], button[aria-label^="Deselect"]',
            );
            const chipLabels: Readonly<Record<string, RegExp>> = {
              image: /圖片|圖像|image/i,
              video: /影片|video/i,
              music: /音樂|music/i,
              "deep-research": /Deep Research/i,
            };
            if (
              (operation.mode === "chat" && chips.length) ||
              (operation.mode !== "chat" &&
                (chips.length !== 1 ||
                  !chipLabels[operation.mode]?.test(
                    chips[0]?.getAttribute("aria-label") || text(chips[0]),
                  )))
            )
              throw new Error("Gemini composer mode changed before dispatch.");
            const modelButtonText = text(elements('[data-test-id="bard-mode-menu-button"]')[0]);
            if (!modelButtonText)
              throw new Error("Gemini model is not observable before dispatch.");
            const buttons = elements(
              'button.send-button, button[aria-label="Send message"], button[aria-label="傳送訊息"]',
            ).filter((element) => !disabled(element));
            if (buttons.length > 1) throw new Error("Gemini send control is ambiguous.");
            if (buttons[0])
              finish({ selector: control(buttons[0], `send-${operation.token}`), modelButtonText });
            break;
          }
          case "accepted":
          case "turn": {
            const fresh = (element: Element): boolean =>
              element.getAttribute("data-oracle-gemini-before") !== operation.token;
            const queries = elements("user-query").filter(fresh);
            const query = queries.find(
              (element) =>
                normalize(
                  text(element.querySelector("user-query-content, .query-text") ?? element),
                ) === normalize(operation.prompt),
            );
            if (!query) break;
            if (operation.kind === "accepted") {
              finish(true);
              break;
            }
            const responses = elements("model-response").filter(
              (element) =>
                fresh(element) &&
                Boolean(query.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
            );
            const response = responses.at(-1);
            if (!response) break;
            const content = response.querySelector("message-content");
            const responseText = text(content);
            const responseComplete =
              Boolean(response.querySelector(".response-footer.complete")) &&
              content?.getAttribute("aria-busy") !== "true" &&
              !content?.querySelector('[aria-busy="true"]');
            const fail = (failure: string): void =>
              finish({
                phase: "failed",
                text: responseText,
                url: location.href,
                control: null,
                citations: [],
                failure,
              });
            const alerts = elements('[role="alert"]').map(text).join("\n");
            const limits =
              /^(?:you(?:'ve| have) reached.*(?:limit|quota)|(?:your )?(?:daily|usage) limit.*(?:reached|exceeded)|try again tomorrow|已達.*(?:上限|限制)|達到.*(?:上限|限制)|明天再試)/i;
            const quota = quotaNotice();
            if (quota || limits.test(responseText) || limits.test(alerts)) {
              fail(`Gemini provider quota/limit notice: ${quota || responseText || alerts}`);
              break;
            }
            const modelButtonText = text(elements('[data-test-id="bard-mode-menu-button"]')[0]);
            if (
              operation.modelButtonText &&
              modelButtonText &&
              operation.modelButtonText !== modelButtonText
            ) {
              fail(
                `Gemini model changed after dispatch: ${operation.modelButtonText} -> ${modelButtonText}.`,
              );
              break;
            }
            const buttons = elements("button, [role='button']", response);
            const plan = buttons.find((element) =>
              /^(?:Start research|Start deep research|開始研究|開始深入研究)$/i.test(
                element.getAttribute("aria-label") || text(element),
              ),
            );
            if (operation.mode === "deep-research") {
              if (plan && !disabled(plan) && !operation.approved) {
                finish({
                  phase: "plan",
                  text: responseText,
                  url: location.href,
                  control: control(plan, operation.token),
                  citations: [],
                });
                break;
              }
              const report = elements(
                "deep-research-report, .research-report, [data-test-id='research-report']",
              ).find(
                (element) =>
                  fresh(element) &&
                  Boolean(
                    query.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
                  ),
              );
              if (!report || !operation.approved) {
                if (!plan && responseComplete && responseText)
                  fail(
                    "Gemini Deep Research returned an ordinary answer without a research plan or completed report.",
                  );
                break;
              }
              const reportComplete =
                report.getAttribute("data-status") === "complete" ||
                Boolean(report.querySelector(".response-footer.complete"));
              if (!reportComplete || elements('[role="progressbar"], .loading', report).length)
                break;
              const citations = elements("a[href]", report).flatMap((link) => {
                const url = link.getAttribute("href") ?? "";
                return /^https?:\/\//i.test(url) ? [{ title: text(link), url }] : [];
              });
              if (!text(report) || !citations.length) break;
              finish({
                phase: "complete",
                text: text(report),
                url: location.href,
                control: null,
                citations,
              });
              break;
            }
            if (!responseComplete) break;
            if (elements('[role="progressbar"], .loading', response).length) break;
            if (operation.mode !== "chat") {
              if (operation.mode === "image") {
                const image = elements("img.image.loaded, img[alt]", response).find(
                  (element) =>
                    element instanceof HTMLImageElement &&
                    element.complete &&
                    element.naturalWidth > 0 &&
                    element.naturalHeight > 0 &&
                    (/由 AI 生成|AI.generated|generated image/i.test(
                      element.getAttribute("alt") ?? "",
                    ) ||
                      (element.classList.contains("image") &&
                        element.classList.contains("loaded"))),
                );
                if (image) {
                  finish({
                    phase: "complete",
                    text: responseText,
                    url: location.href,
                    control: control(image, operation.token),
                    citations: [],
                  });
                } else if (responseText && !elements("img", response).length) {
                  fail("Gemini image completed without generated media.");
                }
                break;
              }
              if (operation.mode === "video") {
                const video = elements("video", response).find(
                  (element) => element instanceof HTMLVideoElement && Boolean(element.currentSrc),
                );
                if (video) {
                  finish({
                    phase: "complete",
                    text: responseText,
                    url: location.href,
                    control: control(video, operation.token),
                    citations: [],
                  });
                } else if (responseText && !elements("video", response).length) {
                  fail("Gemini video completed without generated media.");
                }
                break;
              }
              const audio = elements("audio", response).find(
                (element) => element instanceof HTMLAudioElement && Boolean(element.currentSrc),
              );
              if (audio) {
                finish({
                  phase: "complete",
                  text: responseText,
                  url: location.href,
                  control: control(audio, operation.token),
                  citations: [],
                });
              } else if (responseText && !elements("audio", response).length) {
                fail(
                  "Gemini music completed without generated media; this is not verified account restriction.",
                );
              }
              break;
            }
            if (responseText)
              finish({
                phase: "complete",
                text: responseText,
                url: location.href,
                control: null,
                citations: [],
              });
            break;
          }
        }
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(
      () =>
        finish(undefined, new Error(`Gemini ${operation.kind} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}

export function domExpression(operation: DomOperation, timeoutMs: number): string {
  return `(${geminiDom.toString()})(${JSON.stringify(operation)}, ${timeoutMs})`;
}

/** Decoded image pixels or authenticated in-page media bytes; no download-click fallback. */
export async function captureGeminiMedia(
  operation: {
    readonly kind: "capture-image" | "capture-video" | "capture-music";
    readonly selector: string;
  },
  timeoutMs: number,
): Promise<unknown> {
  const element = document.querySelector(operation.selector);
  if (operation.kind === "capture-image") {
    if (
      !(element instanceof HTMLImageElement) ||
      !element.complete ||
      !element.naturalWidth ||
      !element.naturalHeight
    )
      throw new Error("Gemini generated image has no decoded pixels.");
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Gemini image canvas context is unavailable.");
    context.drawImage(element, 0, 0);
    return {
      dataUrl: canvas.toDataURL("image/png"),
      mimeType: "image/png",
      width: canvas.width,
      height: canvas.height,
    };
  }
  const media =
    operation.kind === "capture-video"
      ? element instanceof HTMLVideoElement
        ? element
        : null
      : element instanceof HTMLAudioElement
        ? element
        : null;
  if (!media?.currentSrc) throw new Error("Gemini media has no current source.");
  const signal = AbortSignal.timeout(timeoutMs);
  // This fetch runs inside the signed-in page, not in the native Node host.
  const response = await fetch(media.currentSrc, { credentials: "include", signal });
  if (!response.ok) throw new Error(`Gemini media capture returned HTTP ${response.status}.`);
  const blob = await response.blob();
  const expectedType = operation.kind === "capture-video" ? "video/" : "audio/";
  if (!blob.type.startsWith(expectedType) || !blob.size)
    throw new Error(`Gemini media capture returned mismatched content: ${blob.type || "unknown"}.`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = (): void => reader.abort();
    const finish = (value?: string, error?: Error): void => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Gemini media FileReader returned no data."));
    };
    reader.onload = () => finish(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () =>
      finish(undefined, reader.error ?? new Error("Gemini media FileReader failed."));
    reader.onabort = () => finish(undefined, new Error("Gemini media capture was aborted."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish(undefined, new Error("Gemini media capture deadline expired."));
      return;
    }
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mimeType: blob.type, byteLength: blob.size };
}

export function mediaCaptureExpression(
  mode: "image" | "video" | "music",
  selector: string,
  timeoutMs: number,
): string {
  return `(${captureGeminiMedia.toString()})(${JSON.stringify({ kind: `capture-${mode}`, selector })}, ${timeoutMs})`;
}
