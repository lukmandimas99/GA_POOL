/**
 * src/browser-registry.js — Track live Puppeteer browsers for cleanup.
 *
 * Why
 * ---
 * FlowGen spawns Chrome via puppeteer.launch() in five different paths:
 *   - session-manager extractCookies (headless, fast)
 *   - session-manager login flow      (visible, long-lived)
 *   - session-manager checkHealth     (headless, fast)
 *   - captcha solver                  (visible, ~10s)
 *   - server detect-project flow      (visible, manual)
 *
 * If the parent Node process dies before any of these `await browser.close()`
 * finally blocks run, the spawned Chrome leaks: it stays alive, holds the
 * user-data-dir lock, and the next launch on that profile fails with
 * "Failed to launch the browser process! undefined".
 *
 * Solution
 * --------
 * 1. Every launch site calls `register(browser)` immediately after a
 *    successful launch. The registry holds a Set of live browser handles.
 *    When a browser emits 'disconnected' it auto-removes itself.
 * 2. The server.js signal handler calls `closeAll()` on SIGINT/SIGTERM/
 *    uncaughtException, which races a 6s timeout per browser.
 *
 * Note we still rely on per-call `finally { await browser.close() }` for
 * normal flow — the registry is the SAFETY NET for abnormal termination.
 */

'use strict';

const browsers = new Set();

function register(browser) {
  if (!browser) return browser;
  browsers.add(browser);
  try {
    browser.on('disconnected', () => browsers.delete(browser));
  } catch { /* old puppeteer versions, ignore */ }
  return browser;
}

function unregister(browser) {
  if (browser) browsers.delete(browser);
}

function count() {
  return browsers.size;
}

async function safeClose(browser, timeoutMs = 5000) {
  if (!browser) return;
  unregister(browser);
  if (typeof browser.isConnected === 'function' && !browser.isConnected()) {
    return;
  }
  
  const pid = typeof browser.process === 'function' ? browser.process()?.pid : null;
  
  try {
    const closer = typeof browser.close === 'function' ? browser.close() : Promise.resolve();
    await Promise.race([
      closer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Close timeout')), timeoutMs)),
    ]);
  } catch (err) {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (killErr) {
        // ignore if already dead or kill fails
      }
    }
  }
}

async function closeAll(log) {
  const arr = [...browsers];
  browsers.clear();
  if (arr.length === 0) return 0;
  if (typeof log === 'function') log(`closing ${arr.length} live browser(s)...`);
  // Race each close() against a 6s timeout; we don't want shutdown to block
  // forever on a stuck CDP protocol session. Parallel allSettled keeps total
  // shutdown bounded by ~6s regardless of how many browsers are open.
  await Promise.allSettled(arr.map(async (b) => {
    try {
      await safeClose(b, 6000);
    } catch { /* swallow */ }
  }));
  return arr.length;
}

module.exports = { register, unregister, count, safeClose, closeAll };
