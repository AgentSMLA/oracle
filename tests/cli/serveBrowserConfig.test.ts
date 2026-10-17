import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServeBrowserConfig } from "../../src/cli/serveBrowserConfig.js";

beforeEach(() => vi.stubEnv("ORACLE_BROWSER_APPROVAL_WAIT", ""));
afterEach(() => vi.unstubAllEnvs());

// No-focus is off by default.
const defaultNoFocus = false;

describe("service host browser routing", () => {
  test("keeps local bootstrap and the 20-second wait by default", () => {
    expect(buildServeBrowserConfig({}, {})).toEqual({
      attachRunning: false,
      remoteChrome: null,
      approvalWaitMs: 20_000,
      noFocus: defaultNoFocus,
    });
  });
  test("keeps the host's Chrome in the background unless the host opts out", () => {
    expect(buildServeBrowserConfig({}, { browser: { noFocus: false } }).noFocus).toBe(false);
    expect(buildServeBrowserConfig({}, { browser: { noFocus: true } }).noFocus).toBe(true);
    expect(
      buildServeBrowserConfig({ browserNoFocus: false }, { browser: { noFocus: true } }).noFocus,
    ).toBe(false);
  });
  test("loads the host route without copying conversation or credential settings", () => {
    expect(
      buildServeBrowserConfig(
        {},
        {
          browser: {
            attachRunning: true,
            remoteChrome: { host: "::1", port: 9333 },
            approvalWaitMs: 75_000,
            thinkingTime: "pro",
            chromePath: "/not-forwarded",
            remoteToken: "not-forwarded",
          },
        },
      ),
    ).toEqual({
      attachRunning: true,
      remoteChrome: { host: "::1", port: 9333 },
      approvalWaitMs: 75_000,
      noFocus: defaultNoFocus,
    });
  });
  test("gives flags precedence over persisted host settings", () => {
    expect(
      buildServeBrowserConfig(
        { browserAttachRunning: false, remoteChrome: "127.0.0.1:9444", browserApprovalWait: "5m" },
        {
          browser: {
            attachRunning: true,
            remoteChrome: { host: "::1", port: 9333 },
            approvalWaitMs: 10,
          },
        },
      ),
    ).toEqual({
      attachRunning: false,
      remoteChrome: { host: "127.0.0.1", port: 9444 },
      approvalWaitMs: 300_000,
      noFocus: defaultNoFocus,
    });
  });
  test("applies environment wait above config and below the explicit flag", () => {
    vi.stubEnv("ORACLE_BROWSER_APPROVAL_WAIT", "55s");
    const config = { browser: { approvalWaitMs: 10 } };
    expect(buildServeBrowserConfig({}, config).approvalWaitMs).toBe(55_000);
    expect(buildServeBrowserConfig({ browserApprovalWait: "5m" }, config).approvalWaitMs).toBe(
      300_000,
    );
  });
  test("rejects invalid endpoints and wait budgets before starting the service", () => {
    expect(() => buildServeBrowserConfig({ remoteChrome: "missing-port" }, {})).toThrow(
      /remote-chrome/,
    );
    expect(() => buildServeBrowserConfig({ browserApprovalWait: "0" }, {})).toThrow(
      /approval wait/,
    );
  });
});
