import { describe, expect, test } from "vitest";
import { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from "../../src/browser/config.js";
import { describeBrowserControlPlan } from "../../src/browser/controlPlan.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import {
  applyBrowserDefaultsFromConfig,
  type BrowserDefaultsOptions,
} from "../../src/cli/browserDefaults.js";

// DEFAULT_BROWSER_CONFIG.noFocus is the one switch for --browser-no-focus. Rehearse both
// settings so flipping it later cannot leave a reader on the old default or drop an opt-out.
describe.each([false, true])("--browser-no-focus with the default set to %s", (defaultOn) => {
  const withDefault = async (check: () => Promise<void> | void) => {
    const original = DEFAULT_BROWSER_CONFIG.noFocus;
    DEFAULT_BROWSER_CONFIG.noFocus = defaultOn;
    try {
      await check();
    } finally {
      DEFAULT_BROWSER_CONFIG.noFocus = original;
    }
  };

  const resolvedFromUserConfig = async (browser: { noFocus?: boolean }) => {
    const options: BrowserDefaultsOptions = {};
    applyBrowserDefaultsFromConfig(options, { browser }, () => "default");
    // The CLI hands buildBrowserConfig the same options object the config defaults filled in.
    const sessionConfig = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      ...options,
    } as Parameters<typeof buildBrowserConfig>[0]);
    return { sessionConfig, resolved: resolveBrowserConfig(sessionConfig) };
  };

  test("an unset flag and config follow the default everywhere", () =>
    withDefault(async () => {
      const { sessionConfig, resolved } = await resolvedFromUserConfig({});
      expect(resolved.noFocus).toBe(defaultOn);
      // Dry runs describe the unresolved session config, so the plan must apply the default too.
      expect(describeBrowserControlPlan(sessionConfig).mayFocusWindow).toBe(!defaultOn);
    }));

  test("browser.noFocus: false in config opts out", () =>
    withDefault(async () => {
      const { sessionConfig, resolved } = await resolvedFromUserConfig({ noFocus: false });
      expect(resolved.noFocus).toBe(false);
      expect(describeBrowserControlPlan(sessionConfig).mayFocusWindow).toBe(true);
    }));

  test("browser.noFocus: true in config opts in", () =>
    withDefault(async () => {
      const { resolved } = await resolvedFromUserConfig({ noFocus: true });
      expect(resolved.noFocus).toBe(true);
    }));
});
