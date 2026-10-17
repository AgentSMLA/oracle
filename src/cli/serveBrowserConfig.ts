import type { UserConfig } from "../config.js";
import { resolveBrowserApprovalWait, resolveBrowserNoFocus } from "../browser/config.js";
import type { RemoteHostBrowserConfig } from "../remote/server.js";
import { parseRemoteChromeTarget } from "./browserConfig.js";
import { applyBrowserDefaultsFromConfig, type BrowserDefaultsOptions } from "./browserDefaults.js";

type ServeBrowserFlags = Pick<
  BrowserDefaultsOptions,
  "browserAttachRunning" | "remoteChrome" | "browserApprovalWait" | "browserNoFocus"
>;

export function buildServeBrowserConfig(
  options: ServeBrowserFlags,
  config: UserConfig,
): RemoteHostBrowserConfig {
  const flags: ServeBrowserFlags = {
    browserAttachRunning: options.browserAttachRunning,
    remoteChrome: options.remoteChrome,
    browserApprovalWait:
      options.browserApprovalWait ??
      (process.env.ORACLE_BROWSER_APPROVAL_WAIT?.trim() || undefined),
    browserNoFocus: options.browserNoFocus,
  };
  const browser = config.browser;
  applyBrowserDefaultsFromConfig(
    flags,
    {
      browser: {
        attachRunning: browser?.attachRunning,
        remoteChrome: browser?.remoteChrome,
        approvalWaitMs: browser?.approvalWaitMs,
        noFocus: browser?.noFocus,
      },
    },
    (key) => (flags[key as keyof ServeBrowserFlags] === undefined ? undefined : "cli"),
  );
  return {
    attachRunning: flags.browserAttachRunning ?? false,
    remoteChrome: flags.remoteChrome ? parseRemoteChromeTarget(flags.remoteChrome) : null,
    approvalWaitMs: resolveBrowserApprovalWait(flags.browserApprovalWait),
    // Window policy belongs to the host: clients cannot set it, and browser.noFocus: false opts out.
    noFocus: resolveBrowserNoFocus({ noFocus: flags.browserNoFocus }),
  };
}
