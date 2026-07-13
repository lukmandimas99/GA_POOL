/**
 * AI Studio activator.
 *
 * One-shot helper that opens a visible Chrome window using a given FlowGen
 * account profile (chrome user-data-dir), navigates to AI Studio's TTS page,
 * and hands control to the user. Use case: a FlowGen account is logged into
 * labs.google.com (for FlowGen) but the same Google account has NOT yet
 * activated AI Studio — when TTS tries to synthesize, Google returns
 * `403 The caller does not have permission`. The fix is one manual click in
 * the AI Studio UI to accept terms / enable the service for that account.
 *
 * Fire-and-forget: we launch the browser, attach a disconnect listener for
 * logging, and return immediately. The user closes Chrome when done; we make
 * no attempt to detect "activation success" automatically (the surest test
 * is a subsequent TTS synthesize call from the same profile, which the user
 * can trigger from Settings → TTS → Test).
 *
 * Lock files: stale `SingletonLock/Cookie/Socket` in a userDataDir prevent
 * Chrome from starting. We unlink them best-effort, same as ttsSession.js.
 * If FlowGen happens to be running with this exact profile already, Chrome
 * will refuse and we surface the error to the caller.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const AISTUDIO_URL = 'https://aistudio.google.com/generate-speech';

const config = require('./config');

/** Locate a Chrome / Edge executable on the host. Same probes as TTS uses. */
function findChrome() {
  if (config.CHROME_EXECUTABLE_PATH && fs.existsSync(config.CHROME_EXECUTABLE_PATH)) {
    return config.CHROME_EXECUTABLE_PATH;
  }
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ];
  return candidates.find((p) => p && fs.existsSync(p));
}

/**
 * Open AI Studio in a visible Chrome window using the given Chrome profile.
 *
 * @param {string} profileDir   Absolute path to userDataDir
 * @param {object} [opts]
 * @param {object} [opts.logger]   pino-like (info/warn)
 * @returns {Promise<{pid: number|null, browserVersion: string}>}
 */
async function openAistudio(profileDir, { logger } = {}) {
  if (!profileDir || typeof profileDir !== 'string') {
    throw new Error('profileDir is required');
  }
  if (!fs.existsSync(profileDir)) {
    throw new Error(`profile dir not found: ${profileDir}`);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('Chrome/Edge executable not found on this host');
  }

  // Best-effort lock cleanup so Chrome doesn't refuse to start on a profile
  // whose previous owner crashed.
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch { /* noop */ }
  }

  logger?.info?.({ profileDir, chromePath }, 'aistudio activator: launching');

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    userDataDir: profileDir,
    defaultViewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Navigate the first available page (Chrome opens with a default about:blank).
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  try {
    await page.goto(AISTUDIO_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    // Navigation failure is non-fatal — user can navigate manually from a blank tab.
    logger?.warn?.({ err: err.message }, 'aistudio activator: navigation failed (user can navigate manually)');
  }

  // Fire-and-forget: detach on disconnect so we don't keep the browser handle.
  browser.on('disconnected', () => {
    logger?.info?.({ profileDir }, 'aistudio activator: browser closed');
  });

  const version = await browser.version().catch(() => 'unknown');
  const pid = browser.process()?.pid ?? null;
  return { pid, browserVersion: version };
}

module.exports = { openAistudio };
