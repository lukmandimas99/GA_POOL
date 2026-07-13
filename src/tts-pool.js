/**
 * TtsPool — concurrent multi-session TTS worker pool.
 *
 * Each worker wraps one TtsSession bound to a distinct Chrome user-data-dir
 * (typically one Google account from a FlowGen account pool). The pool
 * dispatches jobs to idle workers in FIFO order. When all workers are busy
 * jobs queue up and resume as workers free.
 *
 * Design choices:
 *
 *   - Lazy session init. Chromium is heavy (~250-400 MB headed). We don't
 *     launch all N browsers at startup; each worker only inits its session
 *     on first job assignment. Idle workers stay closed unless KEEP_SESSION
 *     is set, in which case they keep their browser open after first use.
 *
 *   - Per-worker error tracking with cooldown. If a worker fails N times
 *     consecutively it goes into 'quarantine' for `cooldownMs`, letting the
 *     other workers absorb traffic. After cooldown it's eligible again.
 *
 *   - Graceful shutdown closes all browsers in parallel with a hard timeout
 *     so process.exit isn't blocked by a stuck Puppeteer call.
 *
 *   - Backwards compat: server.js can construct a pool of size 1 with no
 *     profileDir override and get the exact old single-session behavior.
 *
 * Not done here (callers must decide):
 *   - Pool size / profile dirs come from config or env, not hard-coded.
 *   - The pool does NOT manage account activation flow (T&C accept). Each
 *     profile dir must already be logged into aistudio.google.com.
 *   - The pool does NOT enforce a per-account rate limit. If Google starts
 *     throttling/CAPTCHA-ing a worker, that worker's jobs will fail and the
 *     cooldown logic will throttle it naturally.
 */

'use strict';

const { TtsSession } = require('./tts-session');

class TtsPool {
  /**
   * @param {object} cfg
   * @param {Array<{id: string, profileDir: string, downloadDir?: string}>} cfg.workers
   *        One entry per FlowGen account / chrome-profile. `id` is a stable
   *        label used in logs (e.g. 'acc-1'). `profileDir` is the Chrome
   *        userDataDir. `downloadDir` is optional (defaults to <profileDir>/_downloads
   *        if not provided so worker downloads don't collide).
   * @param {boolean} [cfg.headless]       Pass-through to each TtsSession.
   * @param {boolean} [cfg.keepSession]    If true, idle workers keep their
   *                                       browser open. Default true (mirrors
   *                                       server.js KEEP_SESSION semantic).
   * @param {Function} [cfg.onLog]         Pool-level logger. Worker logs are
   *                                       prefixed with [worker.id].
   * @param {number} [cfg.maxConsecutiveErrors]  Default 3. After this many
   *                                       consecutive failures the worker is
   *                                       quarantined for cooldownMs.
   * @param {number} [cfg.cooldownMs]      Default 30s. Quarantine duration.
   */
  constructor(cfg) {
    if (!cfg || !Array.isArray(cfg.workers) || cfg.workers.length === 0) {
      throw new Error('TtsPool: cfg.workers must be a non-empty array');
    }
    this.headless = !!cfg.headless;
    this.keepSession = cfg.keepSession !== false;
    this.onLog = typeof cfg.onLog === 'function' ? cfg.onLog : () => {};
    this.maxConsecutiveErrors = cfg.maxConsecutiveErrors || 3;
    this.cooldownMs = cfg.cooldownMs || 30_000;

    // Validate worker configs eagerly so misconfig surfaces at boot, not
    // when the user clicks Generate.
    const seenDirs = new Set();
    this.workers = cfg.workers.map((w, idx) => {
      if (!w || !w.profileDir || typeof w.profileDir !== 'string') {
        throw new Error(`TtsPool: worker[${idx}] missing profileDir`);
      }
      const id = w.id || `worker-${idx + 1}`;
      const dirKey = w.profileDir.toLowerCase();
      if (seenDirs.has(dirKey)) {
        throw new Error(`TtsPool: duplicate profileDir at worker[${idx}] (${w.profileDir}) — Chromium SingletonLock would collide`);
      }
      seenDirs.add(dirKey);
      return {
        id,
        profileDir: w.profileDir,
        downloadDir: w.downloadDir || null,  // null = use TtsSession default
        session: null,                       // lazy-init on first job
        busy: false,
        jobsCompleted: 0,
        jobsFailed: 0,
        consecutiveErrors: 0,
        quarantinedUntil: 0,
        lastError: null,
        lastUsedAt: 0,
      };
    });

    // FIFO queue of pending jobs. Each entry: { payload, resolve, reject,
    // enqueuedAt, abortSignal? }.
    this.queue = [];
    // Active job count (for stats).
    this._activeJobs = 0;
    this._shutdown = false;
  }

  /**
   * Submit a job. Returns a promise that resolves to the generate() result
   * once an idle worker picks it up and completes the synthesis. Rejects if
   * the pool is shutting down or the worker call throws (after the
   * maxConsecutiveErrors / cooldown logic has already given up on retries).
   *
   * NOTE: the pool does NOT retry failed jobs automatically. If you want
   * retries, layer them on top (e.g. submit again on rejection). The
   * cooldown logic is about isolating bad workers, not retrying jobs.
   *
   * @param {object} payload  Forwarded to TtsSession.generate(payload).
   * @param {AbortSignal} [signal]  Optional abort. When aborted before
   *        dispatch, the job is yanked from the queue. After dispatch we
   *        don't interrupt the in-flight Puppeteer call (would leave the
   *        page in a broken state); the job runs to completion but the
   *        promise rejects with AbortError as soon as it would resolve.
   */
  submit(payload, signal) {
    if (this._shutdown) {
      return Promise.reject(new Error('TtsPool: shutting down, refusing new jobs'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        payload,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        signal: signal || null,
        aborted: false,
      };
      if (signal) {
        if (signal.aborted) {
          entry.aborted = true;
          return reject(new DOMException('aborted', 'AbortError'));
        }
        signal.addEventListener('abort', () => {
          entry.aborted = true;
          // If still in queue, yank it.
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
          // If in-flight we let it complete; rejection happens in _runJob.
        }, { once: true });
      }
      this.queue.push(entry);
      this._tick();
    });
  }

  /**
   * Try to dispatch as many queued jobs as there are idle, non-quarantined
   * workers. Called after every submit() and every job completion.
   */
  _tick() {
    if (this._shutdown) return;
    const now = Date.now();
    while (this.queue.length) {
      const worker = this.workers.find((w) =>
        !w.busy && w.quarantinedUntil <= now
      );
      if (!worker) break;
      // Skip aborted jobs at head of queue (defensive — they should be
      // removed by the abort listener already).
      while (this.queue.length && this.queue[0].aborted) {
        this.queue.shift();
      }
      if (!this.queue.length) break;
      const job = this.queue.shift();
      worker.busy = true;
      this._activeJobs++;
      this._runJob(worker, job).finally(() => {
        worker.busy = false;
        worker.lastUsedAt = Date.now();
        this._activeJobs--;
        // Reschedule pending work. setImmediate avoids deep recursion when
        // the queue is long and jobs complete synchronously (unlikely but
        // possible on cache hits in the future).
        setImmediate(() => this._tick());
      });
    }
  }

  /**
   * Run one job on a worker. Lazy-inits the session on first use, calls
   * generate(), updates per-worker counters + quarantine state, and
   * settles the caller's promise.
   */
  async _runJob(worker, job) {
    try {
      if (!worker.session) {
        worker.session = new TtsSession({
          headless: this.headless,
          onLog: (msg) => this.onLog(msg),
          profileDir: worker.profileDir,
          downloadDir: worker.downloadDir,
          id: worker.id,
        });
      }
      const result = await worker.session.generate(job.payload);
      worker.jobsCompleted++;
      worker.consecutiveErrors = 0;
      worker.lastError = null;
      if (job.aborted) {
        // Aborted mid-flight: we ran to completion but the caller no longer
        // wants the result. Reject with AbortError to match submit() contract.
        job.reject(new DOMException('aborted', 'AbortError'));
      } else {
        job.resolve(result);
      }
    } catch (err) {
      worker.jobsFailed++;
      worker.consecutiveErrors++;
      worker.lastError = err && err.message ? err.message : String(err);
      if (worker.consecutiveErrors >= this.maxConsecutiveErrors) {
        worker.quarantinedUntil = Date.now() + this.cooldownMs;
        this.onLog(`[pool] worker ${worker.id} quarantined for ${this.cooldownMs}ms after ${worker.consecutiveErrors} consecutive errors (last: ${worker.lastError})`);
        // Try to recover the session: tear down so next dispatch lazy-inits
        // a fresh browser. The Puppeteer page may be in a wedged state.
        try { await worker.session?.close(); } catch {}
        worker.session = null;
        worker.consecutiveErrors = 0; // reset after quarantine
      }
      job.reject(err);
    }
  }

  /**
   * Snapshot of pool state for /api/pool/status. Cheap to call (no I/O).
   */
  getState() {
    const now = Date.now();
    return {
      workers: this.workers.map((w) => ({
        id: w.id,
        profileDir: w.profileDir,
        busy: w.busy,
        jobsCompleted: w.jobsCompleted,
        jobsFailed: w.jobsFailed,
        consecutiveErrors: w.consecutiveErrors,
        quarantined: w.quarantinedUntil > now,
        quarantineRemainingMs: Math.max(0, w.quarantinedUntil - now),
        lastError: w.lastError,
        lastUsedAt: w.lastUsedAt,
        sessionReady: !!(w.session && w.session.ready),
      })),
      queueLength: this.queue.length,
      activeJobs: this._activeJobs,
      poolSize: this.workers.length,
      shutdown: this._shutdown,
    };
  }

  /**
   * Close all worker sessions. Pool refuses new jobs after this is called.
   * In-flight jobs are awaited (no hard cancel) but capped at hardTimeoutMs
   * so process exit isn't blocked indefinitely.
   */
  async shutdown({ hardTimeoutMs = 10_000 } = {}) {
    this._shutdown = true;
    // Reject anything still queued.
    while (this.queue.length) {
      const job = this.queue.shift();
      try { job.reject(new Error('TtsPool: shutdown')); } catch {}
    }
    // Close all sessions in parallel.
    const closes = this.workers.map(async (w) => {
      if (!w.session) return;
      try {
        await Promise.race([
          w.session.close(),
          new Promise((resolve) => setTimeout(resolve, hardTimeoutMs)),
        ]);
      } catch (e) {
        this.onLog(`[pool] worker ${w.id} close failed: ${e.message}`);
      }
      w.session = null;
    });
    await Promise.all(closes);
  }
}

module.exports = { TtsPool };
