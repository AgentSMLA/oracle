import { randomUUID } from "node:crypto";
import type { ChromeClient } from "../types.js";
import { buildActiveComposerRootExpression } from "./composerRoot.js";

// Receipts live in the renderer: retaining the actual removal control, rather than
// its label/count, lets every stage reject removed, replaced, or sent attachments.
export function buildAttachmentEvidenceExpression(
  names: string[],
  action: "read" | "begin" | "confirm" | "clear" = "read",
  id?: string,
): string {
  // Match the original basename literally; never strip a source's own (1).
  // Keep this narrow label matcher independent of attachments.ts (which imports us).
  const basename =
    (names[0] ?? "").split(/[\\/]/).pop()?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const extensionIndex = basename.lastIndexOf(".");
  // Provider collision renames insert a numeric suffix before the extension, or at
  // the end for extensionless and dotfile names (Dockerfile(1), .env(1)).
  const collisionSuffix = "(?:\\s*\\([0-9]+(?:-[0-9]+)*\\))?";
  const japaneseName =
    extensionIndex > 0 && extensionIndex < basename.length - 1
      ? `${escape(basename.slice(0, extensionIndex))}${collisionSuffix}${escape(basename.slice(extensionIndex))}`
      : `${escape(basename)}${collisionSuffix}`;
  const japaneseLabelPattern = basename ? `^${japaneseName} を削除$` : null;
  return `(() => {
    const names = ${JSON.stringify(names)}.map(name => String(name).toLowerCase().replace(/\\s+/g, ' ').trim());
    const action = ${JSON.stringify(action)};
    const id = ${JSON.stringify(id ?? "")};
    const key = '__oracleAttachmentEvidence';
    if (action === 'clear') { delete globalThis[key]; return true; }
    const empty = names.map(() => false);
    if (action === 'read' && !globalThis[key]) return empty;
    const receipts = globalThis[key] ??= new Map();
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const composer = ${buildActiveComposerRootExpression()};
    if (!composer) return action === 'read' ? empty : false;
    const controls = () => Array.from(composer.querySelectorAll('[aria-label*="Remove" i],button[aria-label$=" を削除"]')).filter(node => {
      if (!visible(node) || node.closest('textarea,[contenteditable="true"]')) return false;
      const label = (node.getAttribute('aria-label') ?? '').toLowerCase();
      // Current Japanese cards have no test ID; only their scoped removal
      // button is evidence, not the adjacent filename/open button or container.
      if (node.matches('button[aria-label$=" を削除"]')) {
        return /^.+ を削除$/.test(label) && Boolean(node.closest('[class~="group/composer-attachment"]') && node.closest('[data-composer-attachments]'));
      }
      return /^remove (?:file|attachment|image|photo)(?: |$)/.test(label) || Boolean(node.closest('[data-testid*="chip"],[data-testid*="attachment"],[data-testid*="upload"]'));
    });
    const currentControls = controls();
    // Provider collision renames may change this same Japanese removal button
    // in place. Both labels must remain strict aliases of the assigned filename.
    // The pattern is built from the whitespace-normalized basename, so normalize
    // labels the same way before testing; legacy exact equality stays verbatim.
    const normalize = value => String(value ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const valid = receipt => {
      if (receipt.composer !== composer || !receipt.control?.isConnected || !currentControls.includes(receipt.control)) return false;
      const label = receipt.control.getAttribute('aria-label');
      return label === receipt.label || Boolean(receipt.japaneseLabelPattern && receipt.japaneseLabelPattern.test(normalize(receipt.label)) && receipt.japaneseLabelPattern.test(normalize(label)));
    };
    for (const [receiptId, receipt] of receipts) {
      if (receipt.composer !== composer || (receipt.control && !valid(receipt))) receipts.delete(receiptId);
    }
    if (action === 'begin') {
      for (const [receiptId, receipt] of receipts) {
        if (receipt.name === names[0]) receipts.delete(receiptId);
      }
      receipts.set(id, { name: names[0], composer, before: new Set(currentControls), japaneseLabelPattern: ${JSON.stringify(japaneseLabelPattern)} ? new RegExp(${JSON.stringify(japaneseLabelPattern)}, 'iu') : null });
      return true;
    }
    if (action === 'confirm') {
      const receipt = receipts.get(id);
      if (!receipt || receipt.composer !== composer) return false;
      if (valid(receipt)) return true;
      const claimed = new Set(Array.from(receipts.values()).map(entry => entry.control).filter(Boolean));
      const added = currentControls.filter(control => !receipt.before.has(control) && !claimed.has(control));
      // Ambiguous additions cannot identify which file was accepted.
      if (added.length !== 1) return false;
      receipt.control = added[0];
      receipt.label = added[0].getAttribute('aria-label');
      receipt.before.clear();
      return true;
    }
    return names.map(name => Array.from(receipts.values()).some(receipt => receipt.name === name && valid(receipt)));
  })()`;
}

export async function beginAttachmentEvidence(
  runtime: ChromeClient["Runtime"],
  name: string,
): Promise<string> {
  const id = randomUUID();
  await runtime.evaluate({
    expression: buildAttachmentEvidenceExpression([name], "begin", id),
    returnByValue: true,
  });
  return id;
}

export async function confirmAttachmentEvidence(
  runtime: ChromeClient["Runtime"],
  id: string,
): Promise<boolean> {
  const result = await runtime.evaluate({
    expression: buildAttachmentEvidenceExpression([], "confirm", id),
    returnByValue: true,
  });
  return result.result?.value === true;
}
