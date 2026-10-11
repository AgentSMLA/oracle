#!/usr/bin/env node
// Built CLI and isolated Chrome profiles; synthetic pages, no provider account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-response-proof-"));
const chromePath = [process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome"].find(
  (candidate) => candidate && existsSync(candidate),
);
assert.ok(chromePath, "Set CHROME_PATH to an installed Chromium binary");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const captures = option("--captures");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const states = new Map();
const marker = "ORACLE_RECOVERED_SYNTHETIC_RESPONSE";
const baseline = "Previous synthetic answer; this must never become the new result.";
const userTurn = (id, text) =>
  `<article data-testid="conversation-turn-${id}" data-turn="user"><div data-message-author-role="user" data-message-id="user-${id}">${text}</div></article>`;
const assistantTurn = (id, text) =>
  `<article data-testid="conversation-turn-${id}" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="answer-${id}"><div class="markdown"><p>${text}</p></div></div><button type="button" data-testid="copy-turn-action-button" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('.markdown').innerText)">Copy</button></article>`;

function page(name, state) {
  const stale = name.endsWith("stale");
  const recovered = state.sends > 0 && state.loads >= 3;
  const expired = recovered && name.endsWith("expired");
  return `<!doctype html><meta charset="utf-8"><title>Synthetic response recovery</title>
<style>body{font:18px system-ui;margin:30px}textarea{width:600px;height:100px}button{padding:8px}article{padding:12px}</style>
<button data-testid="profile-button">Synthetic profile</button>
<button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<button type="button" role="radio" data-mode="chat" aria-checked="true">Chat</button>
<button type="button" role="radio" data-mode="work" aria-checked="false">Work</button>
<a class="__menu-item" href="/c/${name}" aria-label="Synthetic Chat">Synthetic Chat</a>
${expired ? '<button data-testid="login-button">Log in</button>' : ""}
<main><div id="turns">${stale ? userTurn(0, "Old prompt") + assistantTurn(1, baseline) : ""}${state.sends ? userTurn(2, "Return the synthetic recovery marker.") : ""}${recovered && !expired ? assistantTurn(3, marker) : ""}</div>
<form><textarea id="prompt-textarea" placeholder="Ask anything"></textarea><button type="button" id="send" data-testid="send-button">Send</button></form></main>
<script>
const name=${JSON.stringify(name)}, stale=${stale};
const turns=document.querySelector('#turns'), editor=document.querySelector('textarea');
function addAnswer(text){turns.insertAdjacentHTML('beforeend',${JSON.stringify(assistantTurn(3, "__TEXT__"))}.replace('__TEXT__',text));}
document.querySelector('form').onsubmit=event=>event.preventDefault();
document.querySelector('#send').onclick=async()=>{
  const prompt=editor.value; await fetch('/sent/'+name,{method:'POST'});
  turns.insertAdjacentHTML('beforeend',${JSON.stringify(userTurn(2, "__PROMPT__"))}.replace('__PROMPT__',prompt)); editor.value='';
  if(stale){addAnswer(${JSON.stringify(baseline)});setTimeout(()=>{document.querySelector('[data-message-id="answer-3"] .markdown').textContent=${JSON.stringify(marker)};},8000);}
};
</script>`;
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/auth/session" || request.url === "/backend-api/me") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ user: { name: "Synthetic" } }));
    return;
  }
  if (request.url.startsWith("/sent/")) {
    const state = states.get(request.url.slice(6));
    assert.ok(state);
    state.sends++;
    response.end("ok");
    return;
  }
  const name = request.url.split("?")[0].split("/").at(-1);
  const state = states.get(name);
  if (!state) {
    response.writeHead(404).end();
    return;
  }
  state.loads++;
  response.setHeader("content-type", "text/html");
  response.end(page(name, state));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function launch(profile) {
  await fs.mkdir(profile, { recursive: true });
  const chrome = new Launcher({
    chromePath,
    userDataDir: profile,
    handleSIGINT: false,
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
    ],
  });
  await chrome.launch();
  return chrome;
}

// Pause fresh local CLI targets before their initial ChatGPT navigation so startup
// login checks also receive synthetic HTML. This never attaches to a user profile.
async function interceptHomepage(port) {
  let version;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(200),
      }).then((response) => response.json());
      break;
    } catch {}
    await pause(10);
  }
  assert.ok(version?.webSocketDebuggerUrl, "CLI Chrome did not start");
  const client = await CDP({ target: version.webSocketDebuggerUrl });
  let failure;
  client.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== "page") return;
    void (async () => {
      await client.send(
        "Fetch.enable",
        {
          patterns: [{ urlPattern: "https://chatgpt.com/*", requestStage: "Request" }],
        },
        sessionId,
      );
      await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((error) => {
      failure = error;
    });
  });
  client.on("Fetch.requestPaused", (event, sessionId) => {
    const auth = new URL(event.request.url).pathname === "/api/auth/session";
    void client
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: auth ? "application/json" : "text/html" },
          ],
          body: Buffer.from(
            auth
              ? JSON.stringify({ user: { name: "Synthetic" } })
              : page("warmup", { sends: 0, loads: 1 }),
          ).toString("base64"),
        },
        sessionId,
      )
      .catch((error) => {
        failure = error;
      });
  });
  await client.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });
  return { client, check: () => assert.equal(failure, undefined) };
}

const remote = await launch(path.join(root, "remote-profile"));
try {
  for (const route of ["remote", "local"]) {
    for (const mode of ["stale", "recheck", "expired"]) {
      const name = `${route}-${mode}`;
      const state = { sends: 0, loads: 0 };
      states.set(name, state);
      const home = path.join(root, name);
      await fs.mkdir(home);
      const args = [
        path.join(repo, "dist/bin/oracle-cli.js"),
        "--engine",
        "browser",
        "--model",
        "gpt-5.5",
        "--browser-model-strategy",
        "ignore",
        "--browser-keep-browser",
        "--browser-archive",
        "never",
        "--chatgpt-url",
        `http://127.0.0.1:${server.address().port}/c/${name}`,
        "--browser-timeout",
        mode === "stale" ? "20s" : "2s",
        "--browser-input-timeout",
        "10s",
        "--browser-recheck-delay",
        "1s",
        "--browser-recheck-timeout",
        "10s",
        "--prompt",
        "Return the synthetic recovery marker.",
        "--no-notify",
        "--wait",
        "--verbose",
      ];
      let attaching;
      let interceptor;
      if (route === "remote") args.push("--remote-chrome", `127.0.0.1:${remote.port}`);
      else {
        const profile = path.join(home, "profile");
        const primer = await launch(profile);
        await Promise.resolve(primer.kill());
        const reservation = net.createServer();
        await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        args.push(
          "--browser-manual-login",
          "--browser-manual-login-profile-dir",
          profile,
          "--browser-headless",
          "--browser-port",
          String(port),
          "--browser-chrome-path",
          chromePath,
        );
        attaching = interceptHomepage(port);
        attaching.catch(() => {});
      }
      let output = "";
      const child = spawn(process.execPath, args, {
        cwd: repo,
        env: { ...process.env, ORACLE_HOME_DIR: home, ORACLE_CHROME_NO_SANDBOX: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
      const done = new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      try {
        if (attaching) interceptor = await attaching;
        const code = await done;
        interceptor?.check();
        if (captures) {
          await fs.mkdir(captures, { recursive: true });
          await fs.writeFile(path.join(captures, `${name}.log`), output);
        }
        assert.equal(code, mode === "expired" ? 1 : 0, output);
        assert.equal(state.sends, 1, JSON.stringify(state));
        assert.match(
          output,
          mode === "stale" ? /Detected stale assistant response/ : /waiting 1s before rechecking/,
        );
        if (mode === "expired") assert.match(output, /ChatGPT session expired during recheck/);
        else {
          assert.match(output, new RegExp(marker));
          if (mode === "recheck")
            assert.match(output, /Recovered assistant response after delayed recheck/);
        }
        const sessions = await fs.readdir(path.join(home, "sessions"));
        assert.equal(sessions.length, 1);
        const metadata = JSON.parse(
          await fs.readFile(path.join(home, "sessions", sessions[0], "meta.json"), "utf8"),
        );
        assert.equal(metadata.status, mode === "expired" ? "error" : "completed");
        console.log(
          JSON.stringify({ case: name, code, ...state, session: metadata.status, passed: true }),
        );
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        if (interceptor) {
          await interceptor.client.Browser.close().catch(() => {});
          await interceptor.client.close().catch(() => {});
        }
      }
    }
  }
} finally {
  await Promise.resolve(remote.kill());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Chrome can still flush its profile briefly after Browser.close resolves.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
