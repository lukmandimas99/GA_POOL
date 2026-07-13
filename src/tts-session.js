/**
 * TTS Session Manager.
 *
 * Satu browser Chromium di-launch sekali (pakai profile login yang sama
 * dengan puppet.js), lalu tetap hidup. Flow saat ini:
 * preset -> voice -> style/pace/accent -> scene/context/text -> run -> download.
 *
 * Dipakai oleh server.js (web UI) dan bisa juga dipakai standalone.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
function ensureProfileUsable(profileDir, logger = () => {}) {
  if (!profileDir || !fs.existsSync(profileDir)) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.unlinkSync(path.join(profileDir, f));
    } catch (e) {
      // ignore
    }
  }
}

// Aktifkan stealth plugin (mask navigator.webdriver, chrome runtime, plugins,
// permissions, WebGL vendor, dll). Ini key untuk bypass BotGuard detection
// di mode headless. Pendekatan sama dengan project VEO yang sudah terbukti
// jalan headless tanpa terdeteksi.
puppeteer.use(StealthPlugin());

// Profile + download dirs — overridable via env so the workspace copy can
// reuse the login session from the original f:/BOT/TTS install instead of
// forcing a fresh login. Defaults to local subdirs.
//
// IMPORTANT: these are now *defaults only* — each TtsSession instance gets
// its own profileDir/downloadDir via the constructor, enabling a multi-
// session pool (one Chromium per FlowGen account) without touching env vars.
// Single-session callers that omit the args fall back to these.
const DEFAULT_PROFILE_DIR = process.env.TTS_PROFILE_DIR
  ? path.resolve(process.env.TTS_PROFILE_DIR)
  : path.resolve(__dirname, 'chrome-profile');
const DEFAULT_DOWNLOAD_DIR = process.env.TTS_DOWNLOAD_DIR
  ? path.resolve(process.env.TTS_DOWNLOAD_DIR)
  : path.resolve(__dirname, 'generations');
// Back-compat exports (named PROFILE_DIR/DOWNLOAD_DIR consumed elsewhere).
const PROFILE_DIR = DEFAULT_PROFILE_DIR;
const DOWNLOAD_DIR = DEFAULT_DOWNLOAD_DIR;
const TARGET_URL =
  'https://aistudio.google.com/generate-speech?model=gemini-3.1-flash-tts-preview';
const SPEECH_SEL = 'ms-speech-block textarea[aria-label="Speech block text"]';
const AUDIO_FILE_EXTS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac']);

function hasAudioExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return AUDIO_FILE_EXTS.has(ext);
}

function isLikelyAudioBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return true; // WAV
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return true; // OGG
  if (buf.slice(0, 4).toString('ascii') === 'fLaC') return true; // FLAC
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return true; // M4A/MP4
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return true;  // MP3 with ID3
  // MP3 frame sync (11111111 111xxxxx)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

// Fallback defaults ketika UI tidak menyediakan scene/context.
// Digunakan hanya bila caller TIDAK meng-override dengan nilai sendiri.
const DEFAULT_SCENE = 'A professional documentary studio setting. The atmosphere is historical, epic, and scholarly, bridging the gap between a modern classroom and a cinematic battlefield';
const DEFAULT_SAMPLE_CONTEXT = 'Narrate with a steady, authoritative, and educational tone. Use "narrative pacing"—meaning, slow down slightly for dramatic revelations and maintain a clear, neutral tone for factual data. The voice should sound knowledgeable and respectful of the historical gravity, avoiding an overly excited or robotic delivery. Aim for the style of a prestigious history documentary narrator.';

const AVAILABLE_VOICES = [
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe',
  'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux',
  'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Puck', 'Pulcherrima',
  'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel',
  'Vindemiatrix', 'Zephyr', 'Zubenelgenubi',
];

// Director's Note options — sesuai UI AI Studio Gemini TTS.
// `label` = teks yg ditampilkan di UI kita. `aliases` = varian string yg
// dicari di menu AI Studio (kadang ada typo "America (Gen)" vs "American (Gen)").
// `description` dipakai UI kita untuk bantu user memilih.
const AVAILABLE_STYLES = [
  { label: 'Vocal Smile', aliases: ['Vocal Smile'], description: 'The "Vocal Smile": soft palate raised for a bright, sunny, inviting tone.' },
  { label: 'Newscaster', aliases: ['Newscaster'], description: 'Professional, authoritative, clear articulation with standard broadcast cadence.' },
  { label: 'Whisper', aliases: ['Whisper'], description: 'Intimate, breathy, close-to-mic proximity effect.' },
  { label: 'Empathetic', aliases: ['Empathetic'], description: 'Warm, understanding, soft tone with gentle inflections.' },
  { label: 'Promo/Hype', aliases: ['Promo/Hype', 'Promo / Hype', 'Promo', 'Hype'], description: 'High energy, punchy consonants, elongated vowels on excitement words.' },
  { label: 'Deadpan', aliases: ['Deadpan'], description: 'Flat affect, minimal pitch variation, dry delivery.' },
];

const AVAILABLE_PACES = [
  { label: 'Natural', aliases: ['Natural'], description: 'Natural conversational pace.' },
  { label: 'Rapid Fire', aliases: ['Rapid Fire'], description: 'Fast, energetic, no dead air. Sentences overlap slightly.' },
  { label: 'The Drift', aliases: ['The Drift'], description: 'Slow, liquid, zero urgency. Long pauses for breath.' },
  { label: 'Staccato', aliases: ['Staccato'], description: 'Short, clipped sentences with distinct pauses between words.' },
];

const AVAILABLE_ACCENTS = [
  { label: 'Neutral', aliases: ['Neutral'], description: 'Neutral, region-less delivery.' },
  { label: 'American (Gen)', aliases: ['American (Gen)', 'America (Gen)', 'American Gen'], description: 'General American accent.' },
  { label: 'American (Valley)', aliases: ['American (Valley)', 'America (Valley)'], description: 'California / Valley American.' },
  { label: 'American (South)', aliases: ['American (South)', 'America (South)'], description: 'Southern US drawl.' },
  { label: 'British (RP)', aliases: ['British (RP)', 'British RP'], description: 'Received Pronunciation — classic British.' },
  { label: 'British (Brixton)', aliases: ['British (Brixton)'], description: 'Urban London / Brixton accent.' },
  { label: 'Transatlantic', aliases: ['Transatlantic'], description: 'Mid-Atlantic accent, old Hollywood feel.' },
  { label: 'Australian', aliases: ['Australian'], description: 'Australian English accent.' },
];

function resolveVoiceName(input) {
  if (!input) return null;
  const hit = AVAILABLE_VOICES.find((v) => v.toLowerCase() === String(input).toLowerCase());
  return hit || input;
}

// Map user-supplied value (label or alias) -> array of candidate strings to
// search for in the AI Studio menu. Returns null if input is empty/unknown.
function resolveDirectorOption(list, input) {
  if (input == null || input === '') return null;
  const target = String(input).replace(/\s+/g, ' ').trim().toLowerCase();
  for (const item of list) {
    if (item.label.toLowerCase() === target) return item.aliases.slice();
    if (item.aliases.some((a) => a.toLowerCase() === target)) return item.aliases.slice();
  }
  // Unknown value — still pass it through as a last-chance literal match.
  return [String(input)];
}

const CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome',
};

function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const def = CHROME_PATHS[process.platform];
  if (def && fs.existsSync(def)) return def;
  const candidates = [
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome tidak ditemukan. Set env CHROME_PATH.');
}

// -------- Session class --------
class TtsSession {
  /**
   * @param {object} opts
   * @param {boolean} [opts.headless]    Run Chromium headless. Default false.
   * @param {Function} [opts.onLog]      Log sink (msg: string) => void.
   * @param {string}  [opts.profileDir]  Chrome user-data-dir for this session.
   *                                     Defaults to DEFAULT_PROFILE_DIR.
   *                                     Each pool worker MUST pass a distinct
   *                                     dir or Chromium SingletonLock collides.
   * @param {string}  [opts.downloadDir] Where WAV downloads land. Defaults to
   *                                     DEFAULT_DOWNLOAD_DIR. Pool workers
   *                                     should use distinct dirs so the
   *                                     download watcher in _downloadWavFromUi
   *                                     doesn't see other workers' files.
   * @param {string}  [opts.id]          Optional human label for logs (e.g.
   *                                     'acc-1'). Prepended to log messages.
   */
  constructor({ headless = false, onLog = () => {}, profileDir, downloadDir, id } = {}) {
    this.headless = headless;
    this.onLog = onLog;
    this.id = id || null;
    this.profileDir = profileDir ? path.resolve(profileDir) : DEFAULT_PROFILE_DIR;
    this.downloadDir = downloadDir ? path.resolve(downloadDir) : DEFAULT_DOWNLOAD_DIR;
    this.browser = null;
    this.page = null;
    this.ready = false;
    this.initializing = null;   // promise if currently initializing
    this._busy = false;         // simple mutex
    this._captured = null;
    this._captureError = null;
  }

  log(...args) {
    const msg = this.id ? `[${this.id}] ${args.join(' ')}` : args.join(' ');
    try { this.onLog(msg); } catch {}
  }

  async ensure() {
    if (this.ready && this.page && !this.page.isClosed()) return;
    if (this.initializing) return this.initializing;
    this.initializing = this._init().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async _init() {
    if (!fs.existsSync(this.profileDir)) {
      throw new Error(
        `Profile Chrome belum ada di ${this.profileDir}. Jalankan dulu: \`node puppet.js login\` di terminal (atau activate akun via YTGEN).`,
      );
    }

    // Make sure the profile is launchable: kill any orphan chrome.exe still
    // holding the userDataDir (from a previous crashed/killed parent), then
    // remove top-level Singleton* + lockfile. Chrome refuses to start
    // otherwise. See scripts/lib/chrome-cleanup.js for the gory details.
    ensureProfileUsable(this.profileDir, (msg) => this.log(msg));

    this.log(`launching browser (headless=${this.headless})...`);
    const args = [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ];
    if (process.platform === 'linux') {
      args.unshift('--disable-setuid-sandbox');
      args.unshift('--no-sandbox');
    }

    this.browser = await puppeteer.launch({
      headless: this.headless ? true : false,
      executablePath: findChrome(),
      userDataDir: this.profileDir,
      defaultViewport: this.headless ? { width: 1600, height: 1200 } : null,
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());

    const cdp = await this.page.target().createCDPSession();
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloadDir,
    });

    // Set UA realistic matching native version & platform (replace HeadlessChrome -> Chrome)
    let ua = await this.browser.userAgent();
    ua = ua.replace(/HeadlessChrome/g, 'Chrome');
    await this.page.setUserAgent(ua);
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Backup webdriver mask (stealth plugin sudah handle, tapi defensive).
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this._attachListeners();

    this.browser.on('disconnected', () => {
      this.log('browser disconnected');
      this.ready = false;
      this.browser = null;
      this.page = null;
    });

    this.log('navigating...');
    await this.page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    if (/accounts\.google\.com/.test(this.page.url())) {
      if (this.headless) {
        await this.close();
        throw new Error(
          'Sesi login Google expired. Jalankan ulang `node puppet.js login` (mode headed) untuk re-login, lalu coba lagi.',
        );
      }
      this.log('butuh login manual di browser (tunggu 5 menit)...');
      await this.page.waitForFunction(
        () => location.hostname.includes('aistudio.google.com'),
        { timeout: 5 * 60_000 },
      );
      await this.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    }

    await this.page.waitForSelector(
      'textarea, [contenteditable="true"], mat-card-content, ms-run-button',
      { timeout: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 1500));

    // klik preset The Master Storyteller kalau textarea belum visible
    const hasTextareaVisible = await this.page.evaluate(() => {
      const els = document.querySelectorAll('textarea, [contenteditable="true"]');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 20) return true;
      }
      return false;
    });
    if (!hasTextareaVisible) {
      this.log('clicking preset The Master Storyteller...');
      const clickedPreset = await this.page.evaluate(() => {
        const cards = document.querySelectorAll('mat-card, mat-card-content, .mat-mdc-card');

        // prioritas: preset "The Master Storyteller"
        for (const card of cards) {
          const title = card.querySelector('.title-text, .mdc-card__title, h3, h4');
          const txt = (title?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (txt.includes('the master storyteller')) {
            card.click();
            return (title?.textContent || 'The Master Storyteller').trim();
          }
        }

        // fallback: card pertama yang punya title
        for (const card of cards) {
          const title = card.querySelector('.title-text, .mdc-card__title, h3, h4');
          if (title) {
            card.click();
            return title.textContent.trim();
          }
        }

        return null;
      });
      this.log('preset clicked:', clickedPreset || '(not found)');
      await new Promise((r) => setTimeout(r, 1500));
    }

    await this.page.evaluate(() => {
      try {
        document.documentElement.style.zoom = '100%';
        document.body.style.zoom = '100%';
      } catch {}
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });

    await this.page.waitForSelector(SPEECH_SEL, { timeout: 30_000 });

    this.ready = true;
    this.log('ready');
  }

  _attachListeners() {
    this.page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('MakerSuiteService/GenerateContent') && res.request().method() === 'POST') {
        try {
          const txt = await res.text();
          if (!res.ok()) {
            this._captureError = `HTTP ${res.status()}: ${txt.slice(0, 300)}`;
            return;
          }
          const j = JSON.parse(txt);
          const cands = [];
          (function find(node) {
            if (node == null) return;
            if (typeof node === 'string') {
              if (node.length > 200 && /^[A-Za-z0-9+/=_-]+$/.test(node)) cands.push(node);
              return;
            }
            if (Array.isArray(node)) { node.forEach(find); return; }
            if (typeof node === 'object') Object.keys(node).forEach((k) => find(node[k]));
          })(j);
          if (!cands.length) return;
          const norm = cands[0].replace(/-/g, '+').replace(/_/g, '/');
          const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
          const pcm = Buffer.from(padded, 'base64');

          const byteRate = (24000 * 1 * 16) / 8;
          const blockAlign = (1 * 16) / 8;
          const h = Buffer.alloc(44);
          h.write('RIFF', 0);
          h.writeUInt32LE(36 + pcm.length, 4);
          h.write('WAVE', 8);
          h.write('fmt ', 12);
          h.writeUInt32LE(16, 16);
          h.writeUInt16LE(1, 20);
          h.writeUInt16LE(1, 22);
          h.writeUInt32LE(24000, 24);
          h.writeUInt32LE(byteRate, 28);
          h.writeUInt16LE(blockAlign, 32);
          h.writeUInt16LE(16, 34);
          h.write('data', 36);
          h.writeUInt32LE(pcm.length, 40);
          this._captured = Buffer.concat([h, pcm]);
        } catch (e) {
          this._captureError = 'Parse error: ' + e.message;
        }
      }
    });
  }

  async _downloadWavFromUi({ deleteAfterRead = false } = {}) {
    const baseline = new Map();
    for (const f of fs.readdirSync(this.downloadDir)) {
      const fp = path.join(this.downloadDir, f);
      try {
        const st = fs.statSync(fp);
        baseline.set(f, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }

    await this.page.waitForFunction(
      () => {
        const icons = Array.from(document.querySelectorAll('span.material-symbols-outlined, span.ms-button-icon-symbol'));
        const icon = icons.find((s) => (s.textContent || '').trim().toLowerCase() === 'download' && s.closest('button'));
        if (!icon) return false;
        const btn = icon.closest('button');
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      },
      { timeout: 120_000 },
    );

    const marked = await this.page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll('span.material-symbols-outlined, span.ms-button-icon-symbol'));
      const icon = icons.find((s) => (s.textContent || '').trim().toLowerCase() === 'download' && s.closest('button'));
      if (!icon) return false;
      const btn = icon.closest('button');
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.scrollIntoView({ block: 'center' });
      btn.setAttribute('data-cascade-download-target', '1');
      return true;
    });
    if (!marked) throw new Error('Tombol download tidak ditemukan/aktif saat klik');

    const targetSel = 'button[data-cascade-download-target="1"]';
    await this.page.waitForSelector(targetSel, { timeout: 5_000 });
    await this.page.click(targetSel);
    await this.page.evaluate(() => {
      document.querySelector('button[data-cascade-download-target="1"]')?.removeAttribute('data-cascade-download-target');
    }).catch(() => {});

    this.log('OK: tombol download diklik');

    const startedAt = Date.now();
    const TIMEOUT_MS = 30_000;
    let latest = null;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const files = fs.readdirSync(this.downloadDir)
        .filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'))
        .filter((f) => hasAudioExtension(f))
        .filter((f) => {
          const fp = path.join(this.downloadDir, f);
          try {
            const st = fs.statSync(fp);
            const prev = baseline.get(f);
            if (!prev) return true;
            return st.mtimeMs > prev.mtimeMs || st.size !== prev.size;
          } catch {
            return false;
          }
        });

      if (files.length) {
        files.sort((a, b) => {
          const ap = path.join(this.downloadDir, a);
          const bp = path.join(this.downloadDir, b);
          return fs.statSync(bp).mtimeMs - fs.statSync(ap).mtimeMs;
        });
        latest = files[0];

        const fp = path.join(this.downloadDir, latest);
        const s1 = fs.statSync(fp).size;
        await new Promise((r) => setTimeout(r, 600));
        const s2 = fs.statSync(fp).size;
        if (s1 > 0 && s1 === s2) {
          const buf = fs.readFileSync(fp);
          if (!isLikelyAudioBuffer(buf)) {
            this.log(`WARN: file bukan audio valid, skip -> ${latest}`);
            const st = fs.statSync(fp);
            baseline.set(latest, { mtimeMs: st.mtimeMs, size: st.size });
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          this.log(`OK: file download terbaca -> ${latest} (${(buf.length / 1024).toFixed(1)} KB)`);
          if (deleteAfterRead) {
            try {
              fs.unlinkSync(fp);
              this.log(`OK: file mentah dihapus -> ${latest}`);
            } catch {}
          }
          return buf;
        }
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    const blobBase64 = await this.page.evaluate(async () => {
      const links = Array.from(document.querySelectorAll('a[download], a[href^="blob:"]'));
      const target = links.find((a) => {
        const href = a.getAttribute('href') || '';
        return href.startsWith('blob:');
      }) || null;
      if (!target) return null;

      try {
        const resp = await fetch(target.href);
        const blob = await resp.blob();
        const b64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => {
            const v = String(fr.result || '');
            const idx = v.indexOf(',');
            resolve(idx >= 0 ? v.slice(idx + 1) : null);
          };
          fr.onerror = () => reject(fr.error || new Error('FileReader error'));
          fr.readAsDataURL(blob);
        });
        return b64;
      } catch {
        return null;
      }
    }).catch(() => null);

    if (blobBase64) {
      const buf = Buffer.from(blobBase64, 'base64');
      if (isLikelyAudioBuffer(buf)) {
        this.log(`OK: file blob download terbaca (${(buf.length / 1024).toFixed(1)} KB)`);
        return buf;
      }
      this.log('WARN: blob download bukan audio valid, diabaikan');
    }

    if (this._captured) {
      if (isLikelyAudioBuffer(this._captured)) {
        this.log(`OK: fallback network capture dipakai (${(this._captured.length / 1024).toFixed(1)} KB)`);
        return this._captured;
      }
      this.log('WARN: network capture bukan audio valid, diabaikan');
    }
    if (this._captureError) throw new Error(this._captureError);
    throw new Error(`Timeout menunggu file download (${latest || 'tidak ada file baru'})`);
  }

  async _waitGenerateResponse(timeoutMs = 120000) {
    const startedAt = Date.now();
    while (!this._captured && !this._captureError && Date.now() - startedAt < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (this._captureError) {
      throw new Error(this._captureError);
    }
    if (!this._captured) {
      throw new Error(`Timeout menunggu response generate (>${timeoutMs}ms)`);
    }

    this.log('OK: response generate sudah diterima');
  }

  async _selectVoice(voiceInput) {
    const voice = resolveVoiceName(voiceInput);
    if (!voice) return;

    this.log(`selecting voice ${voice}...`);
    const chipOk = await this.page.evaluate(() => {
      const chip = document.querySelector('ms-speech-block button.voice-chip');
      if (chip) { chip.click(); return true; }
      return false;
    });
    if (!chipOk) throw new Error('Voice chip tidak ditemukan');

    await new Promise((r) => setTimeout(r, 500));

    await this.page.waitForSelector('mat-dialog-container .voice-list .voice-card', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));

    const result = await this.page.evaluate((target) => {
      const lower = target.toLowerCase();
      const cards = Array.from(document.querySelectorAll('.voice-card[data-voice-name]'));
      const match = cards.find((c) => (c.getAttribute('data-voice-name') || '').toLowerCase() === lower);
      if (!match) return { ok: false };
      match.scrollIntoView({ block: 'center' });
      (match.querySelector('button.voice-card-content') || match).click();
      return { ok: true };
    }, voice);

    await new Promise((r) => setTimeout(r, 500));

    await this.page.evaluate(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    if (!result.ok) throw new Error(`Voice "${voice}" tidak tersedia.`);
    this.log(`OK: voice terpilih -> ${voice} (panel tetap terbuka untuk set style/pace/accent)`);
  }

  async _openDropdownByLabel(labelText) {
    const result = await this.page.evaluate((label) => {
      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      const triggerCandidates = Array.from(document.querySelectorAll(
        `button[aria-label="${label}"], button[aria-label*="${label}"]`,
      ));
      let trigger = triggerCandidates.find(
        (el) => isVisible(el) && el.getAttribute('aria-disabled') !== 'true' && !el.disabled,
      ) || null;

      if (!trigger) {
        const attrGroupTriggers = Array.from(document.querySelectorAll('.attribute-group button[aria-haspopup="menu"]'));
        trigger = attrGroupTriggers.find(
          (el) => isVisible(el) &&
            ((el.getAttribute('aria-label') || '').toLowerCase().includes(label.toLowerCase())),
        ) || null;
      }

      if (!trigger) {
        const labelLower = label.toLowerCase();
        const all = Array.from(document.querySelectorAll('*'));
        const exact = all.find((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          return t === labelLower;
        });
        const partial = all.find((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!t || t.length > 40) return false;
          if (el === document.documentElement || el === document.body) return false;
          return t.includes(labelLower);
        });
        const labelEl = exact || partial;
        if (!labelEl) return { ok: false, reason: `label ${label} not found` };

        const container =
          labelEl.closest('mat-form-field, ms-speaker-settings, .mdc-text-field, div, section, .attribute-group') ||
          labelEl.parentElement ||
          document.body;
        if (!container) return { ok: false, reason: `container ${label} not found` };

        trigger =
          container.querySelector(`button[aria-label="${label}"]`) ||
          container.querySelector(`button[aria-label*="${label}"]`) ||
          container.querySelector('button[aria-haspopup="menu"]') ||
          container.querySelector('button[aria-haspopup="listbox"]') ||
          container.querySelector('button[role="combobox"]') ||
          container.querySelector('mat-select') ||
          container.querySelector('[role="combobox"]');
      }
      if (!trigger) return { ok: false, reason: `trigger ${label} not found` };

      trigger.scrollIntoView({ block: 'center' });
      return { ok: true };
    }, labelText);

    if (!result.ok) {
      this.log(`WARN: gagal buka dropdown ${labelText} (${result.reason || 'unknown'})`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));

    const clicked = await this.page.evaluate((label) => {
      const candidates = Array.from(document.querySelectorAll(
        `button[aria-label="${label}"], button[aria-label*="${label}"]`,
      ));
      const trigger = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
      });
      if (!trigger) return false;
      trigger.click();
      return true;
    }, labelText);
    if (!clicked) {
      this.log(`WARN: trigger ${labelText} tidak berhasil diklik setelah jeda`);
      return false;
    }

    this.log(`OK: dropdown ${labelText} terbuka`);
    return true;
  }

  async _pickOptionFromOpenMenu(labelText, optionTextCandidates) {
    const result = await this.page.evaluate((candidates) => {
      const normalize = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const wanted = candidates.map(normalize);
      const options = Array.from(document.querySelectorAll(
        'mat-option, [role="option"], [role="menuitem"], .mdc-list-item, button[role="option"], button[mat-menu-item], .mat-mdc-menu-item, li[role="option"]',
      ));

      let picked = null;
      for (const opt of options) {
        const txt = normalize(opt.textContent);
        if (wanted.some((w) => txt.includes(w))) {
          picked = opt;
          break;
        }
      }

      if (!picked) {
        document.body.click();
        return { ok: false, reason: `option ${candidates.join('/')} not found` };
      }

      const pickedText = (picked.textContent || '').replace(/\s+/g, ' ').trim();
      picked.click();
      return { ok: true, pickedText };
    }, optionTextCandidates);

    if (!result.ok) {
      this.log(`WARN: gagal set ${labelText} (${result.reason || 'unknown'})`);
      return false;
    }
    this.log(`OK: ${labelText} berhasil diubah -> ${result.pickedText || optionTextCandidates[0]}`);
    return true;
  }

  async _setFieldBySelectors(selectors, value, fieldName) {
    const result = await this.page.evaluate((selList, nextValue) => {
      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      function setValue(el, val) {
        if (!el) return false;
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
        } else if (el.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
        } else {
          return false;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return true;
      }

      for (const sel of selList) {
        const all = Array.from(document.querySelectorAll(sel));
        const target = all.find((x) => isVisible(x) && !x.disabled);
        if (target && setValue(target, nextValue)) return { ok: true, selector: sel };
      }
      return { ok: false };
    }, selectors, value);

    if (!result.ok) {
      this.log(`WARN: gagal isi ${fieldName}`);
      return false;
    }
    this.log(`OK: ${fieldName} terisi (${result.selector})`);
    return true;
  }

  async _fillSceneContextAndText(text, { scene, sampleContext } = {}) {
    // Scene — skip kalau caller pass empty string eksplisit; kalau undefined/null
    // pakai default. UI bisa kirim "" untuk benar-benar mengosongkan.
    let sceneOk = true;
    if (scene !== '') {
      const sceneValue = typeof scene === 'string' ? scene : DEFAULT_SCENE;
      sceneOk = await this._setFieldBySelectors([
        'textarea[aria-label="Scene"]',
        'ms-speech-block textarea[aria-label*="Scene"]',
        'textarea[placeholder*="Scene"]',
      ], sceneValue, 'Scene');
      await new Promise((r) => setTimeout(r, 500));
    } else {
      this.log('Scene: skipped (empty override)');
    }

    let sampleOk = true;
    if (sampleContext !== '') {
      const sampleValue = typeof sampleContext === 'string' ? sampleContext : DEFAULT_SAMPLE_CONTEXT;
      sampleOk = await this._setFieldBySelectors([
        'textarea[aria-label="Sample Context"]',
        'ms-speech-block textarea[aria-label*="Sample"]',
        'textarea[placeholder*="Sample Context"]',
      ], sampleValue, 'Sample Context');
      await new Promise((r) => setTimeout(r, 500));
    } else {
      this.log('Sample Context: skipped (empty override)');
    }

    const textOk = await this._setFieldBySelectors([
      SPEECH_SEL,
      'textarea[aria-label="Speech block text"]',
    ], text, 'Speech block text');

    return sceneOk && sampleOk && textOk;
  }

  async _clickRunButton() {
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('ms-run-button button[type="submit"]')
          || document.querySelector('button.ctrl-enter-submits[type="submit"]');
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      },
      { timeout: 15_000 },
    );

    const clicked = await this.page.evaluate(() => {
      const btn = document.querySelector('ms-run-button button[type="submit"]')
        || document.querySelector('button.ctrl-enter-submits[type="submit"]');
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });

    if (!clicked) {
      this.log('WARN: tombol Run tidak ditemukan saat klik');
      return false;
    }

    this.log('OK: tombol Run berhasil diklik');
    return true;
  }

  async _configureSpeakerDirectorNote({ style, pace, accent, audioProfile, panelAlreadyOpen = false } = {}) {
    // Resolve label → candidate alias list. `null` = user tidak pilih, skip dropdown.
    // Fallback ke default kalau undefined (backward-compat).
    const styleCandidates = style === null
      ? null
      : resolveDirectorOption(AVAILABLE_STYLES, style ?? 'Vocal Smile');
    const paceCandidates = pace === null
      ? null
      : resolveDirectorOption(AVAILABLE_PACES, pace ?? 'Natural');
    const accentCandidates = accent === null
      ? null
      : resolveDirectorOption(AVAILABLE_ACCENTS, accent ?? 'American (Gen)');

    // Audio Profile (free-text persona): undefined = skip (jangan sentuh field),
    // string (termasuk "") = set field tersebut ke nilai itu.
    const shouldSetAudioProfile = typeof audioProfile === 'string';

    // Kalau semuanya null/undefined → skip buka panel sama sekali.
    if (!styleCandidates && !paceCandidates && !accentCandidates && !shouldSetAudioProfile) {
      this.log('Voice settings: skipped (all options null)');
      return;
    }

    // Jika baru saja select voice, panel speaker settings biasanya sudah terbuka
    // (lihat log "panel tetap terbuka..."). Dalam mode ini kita tidak perlu
    // cari/klik trigger voice settings lagi karena klik ulang bisa menutup panel.
    if (!panelAlreadyOpen) {
      const opened = await this.page.evaluate(() => {
        const trigger =
          document.querySelector('button[aria-label*="Open voice settings"]') ||
          document.querySelector('ms-voice-settings button.active-voice-card-trigger') ||
          document.querySelector('button.active-voice-card-trigger');
        if (!trigger) return false;
        trigger.click();
        return true;
      });
      if (!opened) {
        throw new Error('Panel voice settings tidak ditemukan untuk set Audio Profile/Style/Pace/Accent');
      }
    }

    await new Promise((r) => setTimeout(r, 500));
    const panelVisible = await this.page.waitForFunction(
      () => {
        const txt = (document.body?.textContent || '').toLowerCase();
        return txt.includes("director's note")
          || txt.includes('director\'s note')
          || txt.includes('audio profile');
      },
      { timeout: 8_000 },
    ).then(() => true).catch(() => false);
    if (!panelVisible) {
      throw new Error('Panel speaker settings tidak terbuka (Audio Profile tidak bisa diisi)');
    }

    const applyDropdown = async (label, candidates) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const openOk = await this._openDropdownByLabel(label);
        await new Promise((r) => setTimeout(r, 500));
        if (openOk) {
          const pickOk = await this._pickOptionFromOpenMenu(label, candidates);
          if (pickOk) return true;
        }
        this.log(`WARN: retry set ${label} (attempt ${attempt}/2)`);
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    };

    // Audio Profile — free-text textarea di panel "Speaker settings".
    let audioProfileOk = true;
    if (shouldSetAudioProfile) {
      audioProfileOk = await this._setFieldBySelectors([
        '#mat-mdc-dialog-0 > div > div > mat-dialog-content > ms-speaker-settings-panel > section.audio-profile-section > ms-autosize-textarea > textarea',
        'ms-speaker-settings-panel section.audio-profile-section ms-autosize-textarea textarea',
        'ms-speaker-settings-panel ms-autosize-textarea textarea[placeholder*="voice persona"]',
        'ms-speaker-settings-panel section.audio-profile-section textarea',
        'textarea[aria-label="Audio Profile"]',
        'textarea[aria-label*="Audio Profile"]',
        'textarea[aria-label*="audio profile"]',
        'textarea[placeholder*="Describe the voice persona"]',
        'textarea[placeholder*="voice persona"]',
        'textarea[placeholder*="resonant narrator"]',
        'textarea[placeholder*="Audio Profile"]',
      ], audioProfile, 'Audio Profile');
      await new Promise((r) => setTimeout(r, 400));
    }

    let styleOk = true;
    if (styleCandidates) {
      styleOk = await applyDropdown('Style', styleCandidates);
      await new Promise((r) => setTimeout(r, 500));
    }

    let paceOk = true;
    if (paceCandidates) {
      paceOk = await applyDropdown('Pace', paceCandidates);
      await new Promise((r) => setTimeout(r, 500));
    }

    let accentOk = true;
    if (accentCandidates) {
      accentOk = await applyDropdown('Accent', accentCandidates);
    }

    if (styleOk && paceOk && accentOk && audioProfileOk) {
      this.log('OK: Voice settings selesai (Audio Profile/Style/Pace/Accent)');
    } else {
      this.log(`WARN: Voice settings tidak sepenuhnya berhasil (style=${styleOk} pace=${paceOk} accent=${accentOk} audioProfile=${audioProfileOk})`);
      throw new Error('Gagal menerapkan Voice settings (Style/Pace/Accent/Audio Profile) secara konsisten');
    }

    // Commit/simpan perubahan Director's note dulu, baru tutup panel.
    await this.page.evaluate(() => {
      document.body.click();
      const speech = document.querySelector('ms-speech-block textarea[aria-label="Speech block text"]');
      speech?.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    await this.page.evaluate(() => {
      document.querySelector('button[aria-label="Close panel"]')?.click();
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }

  async generate({
    voice,
    text,
    stage = null,
    deleteRawDownload = false,
    scene,
    sampleContext,
    style,
    pace,
    accent,
    audioProfile,
  } = {}) {
    if (this._busy) {
      this.log('busy, queueing...');
      while (this._busy) await new Promise((r) => setTimeout(r, 200));
    }
    this._busy = true;

    try {
      await this.ensure();
      await this.page.evaluate(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      }).catch(() => {});

      if (voice) {
        await this._selectVoice(voice);
      }
      await this._configureSpeakerDirectorNote({
        style,
        pace,
        accent,
        audioProfile,
        panelAlreadyOpen: !!voice,
      });

      const contentOk = await this._fillSceneContextAndText(String(text || ''), {
        scene,
        sampleContext,
      });
      if (!contentOk) {
        this.log('WARN: ada field input yang belum berhasil terisi');
      }

      this._captured = null;
      this._captureError = null;

      await new Promise((r) => setTimeout(r, 1000));
      const runClicked = await this._clickRunButton();
      await new Promise((r) => setTimeout(r, 1000));

      if (stage === 'afterRunClick') {
        this.log('RUN STAGE: stop setelah klik Run');
        return { stage: 'afterRunClick', ok: !!(contentOk && runClicked) };
      }

      await this._waitGenerateResponse(120000);
      await new Promise((r) => setTimeout(r, 1000));

      const wav = await this._downloadWavFromUi({ deleteAfterRead: deleteRawDownload });
      this.log('OK: generate selesai via download, WAV siap disimpan');

      // Auto-close browser setelah download berhasil supaya resource bersih.
      try {
        this.log('closing browser (auto after download)...');
        await this.close();
      } catch (e) {
        this.log('WARN: gagal close browser: ' + e.message);
      }

      return wav;

    } finally {
      this._busy = false;
    }
  }

  async close() {
    this.ready = false;
    const b = this.browser;
    this.browser = null;
    this.page = null;
    if (b) {
      try { await b.close(); } catch {}
      // Tunggu sebentar supaya Chrome benar-benar exit & release file lock.
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  getState() {
    return {
      ready: this.ready,
      busy: this._busy,
      initializing: !!this.initializing,
      hasProfile: fs.existsSync(this.profileDir),
      profileDir: this.profileDir,
      id: this.id,
    };
  }
}

module.exports = {
  TtsSession,
  AVAILABLE_VOICES,
  AVAILABLE_STYLES,
  AVAILABLE_PACES,
  AVAILABLE_ACCENTS,
  DEFAULT_SCENE,
  DEFAULT_SAMPLE_CONTEXT,
  PROFILE_DIR,
  DOWNLOAD_DIR,
  DEFAULT_PROFILE_DIR,
  DEFAULT_DOWNLOAD_DIR,
};
