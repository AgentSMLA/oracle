import { resolveBrowserNoFocus } from "./config.js";
import type { BrowserAutomationConfig } from "./types.js";

type BrowserControlConfig = Pick<
  BrowserAutomationConfig,
  | "attachRunning"
  | "browserTabRef"
  | "remoteChrome"
  | "headless"
  | "hideWindow"
  | "keepBrowser"
  | "manualLogin"
  | "noFocus"
>;

export interface BrowserControlPlan {
  mode: "attach-running" | "remote-chrome" | "headless" | "hidden-window" | "visible-window";
  launchesChrome: boolean;
  mayFocusWindow: boolean;
  /** --browser-no-focus: Oracle skips Chrome activation for launch, new tabs, and send. */
  noFocus?: boolean;
  summary: string;
  guidance: string[];
}

export function describeBrowserControlPlan(config: BrowserControlConfig = {}): BrowserControlPlan {
  const guidance: string[] = [];
  const tabRef = String(config.browserTabRef ?? "").trim();
  const reusesExistingTab = tabRef.length > 0;
  const noFocus = resolveBrowserNoFocus(config);
  const noFocusGuidance = reusesExistingTab
    ? "Oracle reuses that tab without bringing Chrome to the front (--browser-no-focus)."
    : "Oracle opens its tab in a background window and skips Chrome activation during launch, tab creation, and send (--browser-no-focus). A reattach that falls back to relaunching Chrome can still bring it forward.";

  if (config.attachRunning) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) and leaves the existing browser process alone.`
        : "Oracle opens a dedicated tab and leaves the existing browser process alone.",
    );
    if (config.keepBrowser) {
      guidance.push("The browser stays open because Oracle did not launch it.");
    }
    if (noFocus) guidance.push(noFocusGuidance);
    return {
      mode: "attach-running",
      launchesChrome: false,
      mayFocusWindow: !noFocus,
      ...(noFocus ? { noFocus } : {}),
      summary: reusesExistingTab
        ? "attach to an already-running local Chrome tab"
        : "attach to an already-running local Chrome session",
      guidance,
    };
  }

  if (config.remoteChrome) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) in the configured remote Chrome session.`
        : "Oracle opens a dedicated tab in the configured remote Chrome session.",
    );
    guidance.push("Local Chrome launch, cookie copy, and window hiding flags are skipped.");
    // Opening the tab and Page.bringToFront activate a remote Chrome too.
    guidance.push(
      noFocus
        ? noFocusGuidance
        : "Opening the tab and sending the prompt can still bring that Chrome to the front; add --browser-no-focus to keep it in the background.",
    );
    return {
      mode: "remote-chrome",
      launchesChrome: false,
      mayFocusWindow: !noFocus,
      ...(noFocus ? { noFocus } : {}),
      summary: reusesExistingTab
        ? "reuse an existing remote Chrome tab"
        : "reuse an existing remote Chrome session",
      guidance,
    };
  }

  if (config.headless) {
    guidance.push("Headless mode avoids visible UI but may be blocked by ChatGPT or Cloudflare.");
    return {
      mode: "headless",
      launchesChrome: true,
      mayFocusWindow: false,
      summary: "launch headless Chrome",
      guidance,
    };
  }

  if (config.hideWindow) {
    guidance.push("On macOS, Oracle launches Chrome off-screen while keeping the page rendered.");
    guidance.push(
      noFocus
        ? noFocusGuidance
        : "For the calmest shared-desktop flow, prefer --browser-attach-running or --remote-chrome.",
    );
    return {
      mode: "hidden-window",
      launchesChrome: true,
      mayFocusWindow: !noFocus,
      ...(noFocus ? { noFocus } : {}),
      summary: "launch Chrome in hidden-window mode",
      guidance,
    };
  }

  if (config.manualLogin) {
    guidance.push(
      "Manual-login mode may show the persistent Oracle Chrome profile for sign-in or automation.",
    );
  } else if (!noFocus) {
    guidance.push(
      "A visible automation Chrome window may take focus while Oracle controls ChatGPT.",
    );
  }
  guidance.push(
    noFocus
      ? noFocusGuidance
      : "Use --browser-hide-window, --browser-attach-running, or --remote-chrome to reduce desktop disruption.",
  );
  if (config.keepBrowser) {
    guidance.push(
      "Chrome will remain open after the run because --browser-keep-browser is enabled.",
    );
  }

  return {
    mode: "visible-window",
    launchesChrome: true,
    mayFocusWindow: !noFocus,
    ...(noFocus ? { noFocus } : {}),
    summary: "launch visible Chrome",
    guidance,
  };
}

export function formatBrowserControlPlan(plan: BrowserControlPlan, label = "browser"): string[] {
  const risk = plan.mayFocusWindow
    ? "may focus/control the browser UI"
    : plan.noFocus
      ? "keeps Chrome in the background"
      : "does not use a visible local browser window";
  return [
    `[${label}] Browser control: ${plan.summary}; ${risk}.`,
    ...plan.guidance.map((entry) => `[${label}] Browser guidance: ${entry}`),
  ];
}
