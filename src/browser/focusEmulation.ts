import type { BrowserLogger, ChromeClient } from "./types.js";

/**
 * Make the page behave like a focused foreground tab.
 *
 * The send button is activated with trusted CDP input events dispatched at
 * viewport coordinates. Chrome delivers those only to a window that is being
 * composited, so a hidden (`--browser-hide-window`), minimized, or occluded
 * window swallows the click while the automation still believes it clicked.
 * Soft-fails: focus emulation is an optimization, never a hard requirement.
 * Returns whether it was enabled, because --browser-no-focus depends on it.
 */
export async function enableFocusEmulation(
  client: ChromeClient,
  logger: BrowserLogger,
  label: string,
): Promise<boolean> {
  try {
    await client.Emulation.setFocusEmulationEnabled({ enabled: true });
    logger(`[browser] Focus emulation enabled for ${label}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Focus emulation unavailable: ${message}`);
    return false;
  }
}

/**
 * No-focus runs skip Page.bringToFront and rely on focus emulation to keep the page
 * composited. Without emulation a brief focus grab beats a send click that never lands.
 */
export function shouldActivateBeforeTrustedInput(
  noFocus: boolean | undefined,
  focusEmulated: boolean,
  logger: BrowserLogger,
): boolean {
  if (!noFocus) return true;
  if (focusEmulated) return false;
  logger(FOCUS_EMULATION_FALLBACK_LINE);
  return true;
}

const FOCUS_EMULATION_FALLBACK_LINE =
  "[browser] Focus emulation is unavailable; no-focus fallback: Oracle will bring Chrome to the front before trusted clicks.";

/**
 * Attachment uploads and mode switches click with trusted input before the send, so without focus
 * emulation a no-focus run brings the page forward as soon as its tab is set up, as the old tab
 * open did. Returns whether it logged the fallback line.
 */
export async function activateWithoutFocusEmulation(
  page: Pick<ChromeClient["Page"], "bringToFront"> | undefined,
  noFocus: boolean | undefined,
  focusEmulated: boolean,
  logger: BrowserLogger,
): Promise<boolean> {
  if (!noFocus || focusEmulated) return false;
  logger(FOCUS_EMULATION_FALLBACK_LINE);
  await page?.bringToFront().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Could not bring Chrome to the front: ${message}`);
  });
  return true;
}

/**
 * Sign-in and challenge pages need the user's hands, so no-focus runs bring Chrome forward once
 * for them. Soft-fails: the log line still tells the user where to look.
 */
export async function bringChromeForwardForUser(
  page: Pick<ChromeClient["Page"], "bringToFront"> | undefined,
  logger: BrowserLogger,
  reason: string,
): Promise<void> {
  logger(`[browser] no-focus fallback: bringing Chrome to the front for ${reason}.`);
  await page?.bringToFront().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Could not bring Chrome to the front: ${message}`);
  });
}
