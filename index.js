#!/usr/bin/env node

const { chromium } = require("playwright");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stderr.write(`gas - Fetch Google Apps Script web apps from CLI (gas-fetch)

Usage:
  gas <url> [options] [key=value ...]

Arguments:
  <url>              GAS web app URL (required, or set GAS_URL env var)
  key=value          Query parameters to pass to the web app

Options:
  --login            Open a visible browser for manual login
  --post <json>      Send a POST request with JSON body (triggers doPost)
  --profile <dir>    Custom browser profile directory
  --timeout <ms>     Navigation timeout in milliseconds (default: 30000)
  -h, --help         Show this help

Examples:
  gas https://script.google.com/.../exec --login
  gas https://script.google.com/.../exec query=newer_than:1d
  gas https://script.google.com/.../exec --post '{"action":"send"}'
  GAS_URL=https://script.google.com/.../exec gas
`);
  process.exit(0);
}

const loginMode = args.includes("--login");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const customProfile = getArgValue("--profile");
const postBody = getArgValue("--post");
const timeout = Number(getArgValue("--timeout")) || 30000;

// First non-flag argument that looks like a GAS URL
const gasUrl =
  args.find((a) => a.startsWith("https://script.google.com/")) ||
  process.env.GAS_URL;

if (!gasUrl) {
  process.stderr.write(
    "ERROR: No GAS URL provided. Pass it as first argument or set GAS_URL env var.\n" +
      "Run gas-fetch --help for usage.\n"
  );
  process.exit(1);
}

// Derive a stable profile dir from the URL so different apps don't share sessions
const urlHash = crypto
  .createHash("md5")
  .update(gasUrl)
  .digest("hex")
  .slice(0, 8);
const defaultProfileBase =
  process.env.GAS_FETCH_PROFILES ||
  path.join(process.env.HOME || require("os").homedir(), ".config", "gas-fetch", "profiles");
const profileDir = customProfile || path.join(defaultProfileBase, urlHash);

// Extract workspace domain from URL for account selector (if present)
// e.g. https://script.google.com/a/macros/example.com/s/.../exec
const domainMatch = gasUrl.match(/\/a\/macros\/([^/]+)\//);
const workspaceDomain = domainMatch ? domainMatch[1] : null;

// Collect key=value pairs as query params (skip flags and their values)
const flagsWithValues = new Set(["--profile", "--post", "--timeout"]);
const skipNext = new Set();
const params = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (skipNext.has(i)) continue;
  if (flagsWithValues.has(a)) {
    skipNext.add(i + 1);
    continue;
  }
  if (a.startsWith("--") || a.startsWith("https://")) continue;
  if (a.includes("=")) {
    const [k, ...v] = a.split("=");
    params[k] = v.join("=");
  }
}

function log(...msg) {
  process.stderr.write(msg.join(" ") + "\n");
}

async function main() {
  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: !loginMode,
    channel: "chromium",
  });

  const page = browser.pages()[0] || (await browser.newPage());

  let url = gasUrl;
  if (Object.keys(params).length > 0) {
    url += "?" + new URLSearchParams(params).toString();
  }

  log("gas-fetch: navigating...");
  await page.goto(url, { waitUntil: "networkidle", timeout });

  const currentUrl = page.url();

  if (isGASPage(currentUrl)) {
    log("gas-fetch: authenticated");
  } else if (isAccountChooser(currentUrl)) {
    log("gas-fetch: account chooser detected, auto-selecting...");
    await autoSelectAccount(page);
  } else if (isLoginPage(currentUrl)) {
    if (!loginMode) {
      log("gas-fetch: login required — run with --login first");
      await browser.close();
      process.exit(1);
    }
    log("gas-fetch: please log in in the browser window...");
    await waitForGASPage(page);
    log("gas-fetch: login successful");
  }

  // In login mode, verify the response looks valid; if not, let user fix it
  if (loginMode && isGASPage(page.url())) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (isErrorPage(text)) {
      log("gas-fetch: WARNING — page loaded but looks like an error:");
      log("gas-fetch:   " + text.substring(0, 200));
      log("gas-fetch: the browser will stay open — please navigate or re-login manually.");
      log("gas-fetch: once the correct page loads, it will be detected automatically.");
      await waitForGASPage(page, true);
    }
  }

  // Handle POST: re-navigate via fetch() inside the authenticated browser context
  if (postBody && isGASPage(page.url())) {
    log("gas-fetch: sending POST...");
    const result = await page.evaluate(
      async ({ url, body }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body,
          redirect: "follow",
        });
        return res.text();
      },
      { url: gasUrl, body: postBody }
    );
    process.stdout.write(result);
    await browser.close();
    return;
  }

  if (!isGASPage(page.url())) {
    log("gas-fetch: failed to reach GAS page — " + page.url());
    await browser.close();
    process.exit(1);
  }

  const body = await page.locator("body").innerText().catch(() => "");
  process.stdout.write(body.trim());

  await browser.close();
}

async function autoSelectAccount(page) {
  const selectors = workspaceDomain
    ? [
        `[data-identifier*="${workspaceDomain}"]`,
        `[data-email*="${workspaceDomain}"]`,
      ]
    : [];
  selectors.push("li[data-identifier]", "div[data-authuser]");

  for (const selector of selectors) {
    const el = page.locator(selector);
    if ((await el.count()) > 0) {
      log("gas-fetch:   clicking", selector);
      await el.first().click();
      await page.waitForLoadState("networkidle");
      if (isGASPage(page.url())) return;
    }
  }

  if (loginMode) {
    log("gas-fetch: auto-select failed — please click your account in the browser");
    await waitForGASPage(page);
  } else {
    log("gas-fetch: auto-select failed — run with --login to handle manually");
    await page.context().close();
    process.exit(1);
  }
}

async function waitForGASPage(page, mustBeValid = false) {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await page.waitForTimeout(1000);
      if (!isGASPage(page.url())) continue;
      if (!mustBeValid) break;
      // In strict mode, also verify the content isn't an error page
      const text = await page.locator("body").innerText().catch(() => "");
      if (!isErrorPage(text)) break;
    }
    await page.waitForLoadState("networkidle");
  } catch (e) {
    if (e.message.includes("closed")) {
      log("gas-fetch: browser was closed before login completed");
    }
    throw e;
  }
}

function isGASPage(url) {
  return (
    (url.includes("script.google.com") && url.includes("/exec")) ||
    url.includes("script.googleusercontent.com")
  );
}

function isAccountChooser(url) {
  return url.includes("AccountChooser") || url.includes("accountchooser");
}

function isLoginPage(url) {
  return (
    url.includes("accounts.google.com") ||
    url.includes("ServiceLogin") ||
    url.includes("signin")
  );
}

function isErrorPage(text) {
  const errorPatterns = [
    "不存在",
    "does not exist",
    "not found",
    "404",
    "drive.google.com/start",
    "云端硬盘",
    "Google Drive",
  ];
  const lower = text.toLowerCase();
  return errorPatterns.some((p) => lower.includes(p.toLowerCase()));
}

main().catch((e) => {
  log("gas-fetch: ERROR:", e.message);
  process.exit(1);
});
