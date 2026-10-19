import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../constants.js";

// Resolve from the visible editor, never an unrelated form's send button.
export function buildActiveComposerRootExpression(): string {
  return `(() => {
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const prompt = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
    if (!prompt) return null;
    for (let node = prompt.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const testId = String(node.getAttribute('data-testid') || '').toLowerCase();
      if (String(node.tagName || '').toLowerCase() !== 'button' && testId.includes('composer') && !/footer|action|plus|send/.test(testId)) return node;
    }
    // Current layouts can keep cards beside the form, inside the composer wrapper.
    const form = prompt.closest('form');
    if (form) {
      const parent = form.parentElement;
      // Older wrappers have no test ID. Only widen across attachment regions,
      // never another form, conversation history, or unrelated controls.
      const attachmentRegion = '[data-composer-attachments],[data-testid*="attachment"],[data-testid*="chip"],[data-testid*="upload"],input[type="file"]';
      if (parent && parent !== document.body && parent !== document.documentElement &&
          Array.from(parent.children).every(node => node === form || node.matches(attachmentRegion))) return parent;
      return form;
    }
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    let fallback = null;
    for (let node = prompt.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (!sendSelectors.some(selector => node.querySelector(selector))) continue;
      fallback ??= node;
      if (node.querySelector('input[type="file"],[data-testid*="attachment"],[data-composer-attachments],[aria-label*="Remove" i]')) return node;
    }
    return fallback;
  })()`;
}
