#!/usr/bin/env node
// Run with node --import tsx. Real disposable Chrome, synthetic pages, no provider account.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig } from "../src/browser/config.ts";
import {
  launchChrome,
  connectWithNewTab,
  ensureChromePageTargetAfterClose,
  closeTab,
} from "../src/browser/chromeLifecycle.ts";
import { enableFocusEmulation } from "../src/browser/focusEmulation.ts";
import { submitPrompt } from "../src/browser/actions/promptComposer.ts";
import { uploadAttachmentViaDataTransfer } from "../src/browser/actions/remoteFileTransfer.ts";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.homedir(), "oracle-no-focus-proof-"));
const logger = Object.assign(() => {}, { verbose: false });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const foreground = async () => {
  const { stdout } = await exec("peekaboo", ["app", "list", "--json"]);
  const apps = JSON.parse(stdout).data.apps;
  const active = apps.find((app) => app.is_active);
  assert.ok(active, "A native foreground observer is required");
  return active.pid;
};
const observeForeground = process.platform === "darwin";
if (process.platform === "linux") process.env.ORACLE_CHROME_NO_SANDBOX = "1";
const results = [];
try {
  const attachmentPath = path.join(root, "synthetic.txt");
  await writeFile(attachmentPath, "ORACLE_SYNTHETIC_ATTACHMENT\n");
  for (const noFocus of [false, true]) {
    if (observeForeground) {
      await exec("peekaboo", ["app", "focus", "Finder", "--foreground", "--json"]);
    }
    const initialPid = observeForeground ? await foreground() : null;
    const samples = [];
    let sampling = true;
    let phase = "launch";
    const sampler = (async () => {
      while (sampling) {
        if (observeForeground) samples.push({ phase, pid: await foreground() });
        await pause(100);
      }
    })();
    sampler.catch(() => {});
    let chrome;
    let connection;
    try {
      await mkdir(path.join(root, noFocus ? "background" : "foreground"));
      chrome = await launchChrome(
        resolveBrowserConfig({
          noFocus,
          manualLogin: false,
          headless: !observeForeground,
          chromePath: process.env.CHROME_PATH,
        }),
        path.join(root, noFocus ? "background" : "foreground"),
        logger,
      );
      phase = "target";
      connection = await connectWithNewTab(chrome.port, logger, "about:blank", undefined, {
        background: noFocus,
        fallbackToDefault: false,
      });
      const { client, targetId } = connection;
      const { Runtime, Page, DOM, Input } = client;
      await Promise.all([Page.enable(), DOM.enable()]);
      assert.equal(await enableFocusEmulation(client, logger, "synthetic proof"), true);
      const evaluate = async (expression) => {
        const value = await Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        assert.equal(value.exceptionDetails, undefined);
        return value.result.value;
      };
      await evaluate(`(() => {
        document.body.innerHTML = '<h1>Oracle synthetic background proof</h1><main><form><textarea id="prompt-textarea" name="prompt-textarea" style="width:500px;height:100px"></textarea><input type="file"><div id="chips"></div><button type="button" data-testid="send-button">Send</button></form><div id="turns"></div></main>';
        window.proof = { sends: [], files: [] };
        document.querySelector('input').onchange = event => {
          for (const file of event.target.files) {
            window.proof.files.push(file.name);
            const chip = document.createElement('div'); chip.dataset.testid = 'attachment-chip'; chip.textContent = file.name;
            const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove attachment'); chip.append(remove);
            document.querySelector('#chips').append(chip);
          }
        };
        const send = event => {
          const textarea = document.querySelector('textarea');
          window.proof.sends.push({ text: textarea.value, trusted: event.isTrusted, files: [...window.proof.files] });
          const turn = document.createElement('article'); turn.dataset.testid = 'conversation-turn-' + window.proof.sends.length; turn.dataset.messageAuthorRole = 'user'; turn.dataset.messageId = 'proof-' + window.proof.sends.length;
          const text = document.createElement('p'); text.textContent = textarea.value; turn.append(text);
          for (const name of window.proof.files) { const chip = document.createElement('div'); chip.dataset.testid = 'attachment-chip'; chip.textContent = name; turn.append(chip); }
          document.querySelector('#turns').append(turn); textarea.value = ''; document.querySelector('#chips').replaceChildren();
        };
        document.querySelector('[data-testid="send-button"]').onclick = send;
      })()`);
      phase = "text";
      await submitPrompt(
        {
          runtime: Runtime,
          input: Input,
          page: Page,
          activateBeforeTrustedInput: !noFocus,
          baselineTurns: 0,
        },
        "ORACLE_SYNTHETIC_TEXT",
        logger,
      );
      phase = "attachment";
      await uploadAttachmentViaDataTransfer(
        { runtime: Runtime, dom: DOM },
        { path: attachmentPath, displayPath: "synthetic.txt" },
        logger,
      );
      await submitPrompt(
        {
          runtime: Runtime,
          input: Input,
          page: Page,
          activateBeforeTrustedInput: !noFocus,
          attachmentNames: ["synthetic.txt"],
          attachmentNavigationUrl: "about:blank",
          baselineTurns: 1,
        },
        "ORACLE_SYNTHETIC_ATTACHMENT_SEND",
        logger,
      );
      const sends = await evaluate("window.proof.sends");
      assert.equal(sends.length, 2);
      assert.ok(sends.every((send) => send.trusted));
      assert.deepEqual(sends[1].files, ["synthetic.txt"]);
      phase = "cleanup";
      // Exercise the kept-browser final-page replacement path too.
      const targets = await client.Target.getTargets();
      for (const target of targets.targetInfos.filter(
        (t) => t.type === "page" && t.targetId !== targetId,
      )) {
        await closeTab(chrome.port, target.targetId, logger);
      }
      assert.ok(
        await ensureChromePageTargetAfterClose(chrome.port, targetId, logger, undefined, {
          background: noFocus,
        }),
      );
      assert.equal(await closeTab(chrome.port, targetId, logger), true);
      await pause(500);
      if (observeForeground) {
        samples.push({ phase, pid: await foreground() });
        if (noFocus)
          assert.ok(
            samples.every((sample) => sample.pid === initialPid),
            JSON.stringify(samples),
          );
        else
          assert.ok(
            samples.some((sample) => sample.pid === chrome.pid),
            "The default control must demonstrate foreground activation",
          );
      }
      results.push({ noFocus, chromePid: chrome.pid, initialPid, sends, samples });
    } finally {
      sampling = false;
      await sampler;
      await connection?.client.close();
      await chrome?.kill();
    }
  }
  console.log(JSON.stringify({ platform: process.platform, observeForeground, results }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
