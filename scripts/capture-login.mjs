import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const [, , url, storagePath, channel = "chrome"] = process.argv;
if (!url || !storagePath) {
  console.error("用法：node scripts/capture-login.mjs <url> <storagePath> [chrome|msedge|chromium]");
  process.exit(2);
}

const userDataDir = await mkdtemp(path.join(tmpdir(), "minimax-flow-login-"));
let browser;
let chromeProcess;
let stopping = false;

try {
  browser = await openLoginBrowser(url, channel, userDataDir);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await openLoginPage(context, url);
  await focusPage(page);
  console.log("READY");

  let latest = null;
  let disconnected = false;
  browser.once("disconnected", () => {
    disconnected = true;
  });
  const remember = async () => {
    const snapshot = await snapshotOpenPages(context);
    if (snapshot) latest = snapshot;
  };

  while (browser.isConnected() && !disconnected) {
    await remember();
    if (!context.pages().some((page) => page.url().startsWith("http"))) break;
    await delay(2000);
  }
  await remember();
  if (!latest) throw new Error("瀏覽器已關閉，但沒有取得登入狀態。");
  await writeFile(storagePath, JSON.stringify(latest));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopLoginBrowser(browser, userDataDir);
}

async function openLoginBrowser(targetUrl, browserChannel, profileDir) {
  if (process.platform === "darwin" && (browserChannel === "chrome" || browserChannel === "msedge")) {
    const port = await freePort();
    const executable = browserChannel === "msedge"
      ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const appName = browserChannel === "msedge" ? "Microsoft Edge" : "Google Chrome";
    chromeProcess = spawn(executable, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--new-window",
      targetUrl,
    ], { stdio: "ignore" });
    chromeProcess.once("exit", (code) => {
      if (!stopping && code !== 0) console.error(`${appName} 已結束（結束碼 ${code ?? "未知"}）。`);
    });
    await waitForDebugger(port);
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }

  return browserChannel === "chromium"
    ? chromium.launch({ headless: false })
    : chromium.launch({ channel: browserChannel, headless: false });
}

async function openLoginPage(context, targetUrl) {
  const existing = context.pages().find((page) => page.url().startsWith("http"));
  const page = existing ?? context.pages()[0] ?? await context.newPage();
  if (!page.url().startsWith(targetUrl)) await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  return page;
}

async function focusPage(page) {
  await page.bringToFront();
}

async function snapshotOpenPages(context) {
  let cookies = [];
  try {
    cookies = await context.cookies();
  } catch {
    return null;
  }

  const origins = new Map();
  for (const page of context.pages()) {
    if (!page.url().startsWith("http")) continue;
    let origin;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    try {
      const localStorage = await page.evaluate(() => {
        const items = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const name = window.localStorage.key(index);
          if (!name) continue;
          items.push({ name, value: window.localStorage.getItem(name) ?? "" });
        }
        return items;
      });
      if (localStorage.length > 0) origins.set(origin, localStorage);
    } catch {
      // The page is navigating. Keep the previous snapshot for this origin.
    }
  }

  return {
    cookies,
    origins: [...origins].map(([origin, localStorage]) => ({ origin, localStorage })),
  };
}

async function stopLoginBrowser(connectedBrowser, profileDir) {
  if (stopping) return;
  stopping = true;
  await connectedBrowser?.close().catch(() => {});
  if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill("SIGKILL");
  if (process.platform === "darwin") {
    const killer = spawn("pkill", ["-f", profileDir], { stdio: "ignore" });
    await onceExit(killer).catch(() => {});
  }
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 20_000;
  let lastError = "沒有回應";
  while (Date.now() < deadline) {
    try {
      const status = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.setTimeout(1000, () => request.destroy(new Error("timeout")));
        request.on("error", reject);
      });
      if (status === 200) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
  }
  throw new Error(`瀏覽器沒有在 20 秒內開啟（${lastError}）。`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function onceExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
