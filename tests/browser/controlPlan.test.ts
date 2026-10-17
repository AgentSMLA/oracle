import { describe, expect, test } from "vitest";
import {
  describeBrowserControlPlan,
  formatBrowserControlPlan,
} from "../../src/browser/controlPlan.js";

describe("browser control plan", () => {
  test("describes visible Chrome as a focus-taking launch when no-focus is turned off", () => {
    const plan = describeBrowserControlPlan({ noFocus: false });

    expect(plan).toMatchObject({
      mode: "visible-window",
      launchesChrome: true,
      mayFocusWindow: true,
    });
    expect(formatBrowserControlPlan(plan, "dry-run").join("\n")).toContain(
      "Browser control: launch visible Chrome",
    );
    expect(formatBrowserControlPlan(plan, "dry-run").join("\n")).toContain("--browser-hide-window");
  });

  test("describes attach-running as a lower-disruption existing browser flow", () => {
    const plan = describeBrowserControlPlan({ attachRunning: true, noFocus: false });

    expect(plan).toMatchObject({
      mode: "attach-running",
      launchesChrome: false,
      mayFocusWindow: true,
    });
    expect(formatBrowserControlPlan(plan, "browser").join("\n")).toContain(
      "leaves the existing browser process alone",
    );
  });

  test("describes hidden and remote modes distinctly", () => {
    const hidden = describeBrowserControlPlan({ hideWindow: true });
    expect(hidden.mode).toBe("hidden-window");
    expect(hidden.guidance.join(" ")).toContain("off-screen");
    expect(
      describeBrowserControlPlan({ remoteChrome: { host: "127.0.0.1", port: 9222 } }).mode,
    ).toBe("remote-chrome");
    expect(describeBrowserControlPlan({ headless: true }).mode).toBe("headless");
    // Only an explicit no-focus plan may claim to keep a visible Chrome in the background.
    for (const config of [{ headless: true }, { headless: true, noFocus: true }]) {
      expect(formatBrowserControlPlan(describeBrowserControlPlan(config), "browser")[0]).toBe(
        "[browser] Browser control: launch headless Chrome; does not use a visible local browser window.",
      );
    }
  });

  test("counts remote Chrome as focus-taking when no-focus is turned off", () => {
    // Opening the tab and Page.bringToFront activate a remote Chrome too.
    const remote = { remoteChrome: { host: "127.0.0.1", port: 9222 } };
    const plan = describeBrowserControlPlan({ ...remote, noFocus: false });
    const output = formatBrowserControlPlan(plan, "browser");
    expect(plan.mayFocusWindow).toBe(true);
    expect(output[0]).toBe(
      "[browser] Browser control: reuse an existing remote Chrome session; may focus/control the browser UI.",
    );
    // Right on every platform: off is the default on Linux and Windows, an opt-out on macOS.
    expect(output.join("\n")).toContain("add --browser-no-focus to keep it in the background");

    const background = describeBrowserControlPlan({ ...remote, noFocus: true });
    expect(background.mayFocusWindow).toBe(false);
    expect(formatBrowserControlPlan(background, "browser")[0]).toBe(
      "[browser] Browser control: reuse an existing remote Chrome session; keeps Chrome in the background.",
    );
  });

  test("describes no-focus launches as keeping Chrome in the background", () => {
    for (const config of [{ noFocus: true }, { noFocus: true, hideWindow: true }]) {
      const plan = describeBrowserControlPlan(config);
      const output = formatBrowserControlPlan(plan, "browser").join("\n");
      expect(plan).toMatchObject({ launchesChrome: true, mayFocusWindow: false });
      expect(output).toContain("keeps Chrome in the background");
      expect(output).toContain("opens its tab in a background window");
      expect(output).not.toContain("may take focus");
    }
    expect(describeBrowserControlPlan({ attachRunning: true, noFocus: true }).mayFocusWindow).toBe(
      false,
    );
  });

  test("describes browser-tab reuse without claiming to open a dedicated tab", () => {
    const plan = describeBrowserControlPlan({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      browserTabRef: "current",
    });
    const output = formatBrowserControlPlan(plan, "browser").join("\n");

    expect(plan.summary).toBe("reuse an existing remote Chrome tab");
    expect(output).toContain("reuses the matching ChatGPT tab (current)");
    expect(output).not.toContain("opens a dedicated tab");

    for (const mode of [
      { remoteChrome: { host: "127.0.0.1", port: 9222 } },
      { attachRunning: true },
    ]) {
      const reused = formatBrowserControlPlan(
        describeBrowserControlPlan({ ...mode, browserTabRef: "current", noFocus: true }),
        "browser",
      ).join("\n");
      expect(reused).toContain("reuses that tab without bringing Chrome to the front");
      expect(reused).not.toContain("background window");
    }
  });
});
