/**
 * Multi-Account Session Manager — GA_POOL Central Engine
 * 
 * Mengelola multiple Google accounts dengan persistent Puppeteer browser profiles.
 * Setiap akun punya userDataDir sendiri di ./data/browser-data/<id>/
 * Cookies di-refresh otomatis via keep-alive visits.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const config = require('./config');
const axios = require('axios');

// --- Constants ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const BROWSER_DATA_DIR = path.join(DATA_DIR, 'browser-data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const KEEP_ALIVE_INTERVAL_MS = (config.KEEP_ALIVE_INTERVAL_MINUTES || 30) * 60 * 1000;
const LABS_URL = 'https://labs.google';
const LABS_FLOW_PATH = '/fx/id/tools/flow';

// --- State ---
const accounts = new Map();
let activeAccountId = null;
let keepAliveTimer = null;
let roundRobinIndex = 0;
let roundRobinEnabled = true;

// --- Helpers ---

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function log(msg) {
    const now = new Date();
    const ts = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join(':');
    console.log('[SessionMgr ' + ts + '] ' + msg);
}

/**
 * Remove stale Chrome lock files so Puppeteer doesn't refuse to start.
 */
function ensureProfileUsable(profileDir) {
    if (!profileDir || !fs.existsSync(profileDir)) return;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(profileDir, f)); } catch { /* noop */ }
    }
}

// --- Persistence ---

function saveAccounts() {
    ensureDir(DATA_DIR);
    const data = [];
    for (const [id, acc] of accounts) {
        data.push({
            id: acc.id,
            label: acc.label,
            email: acc.email,
            status: acc.status,
            lastRefresh: acc.lastRefresh,
            lastUsed: acc.lastUsed,
            cookies: acc.cookies,
            rawCookies: acc.rawCookies,
            projectId: acc.projectId,
            projects: acc.projects,
            googleOneTier: acc.googleOneTier,
            profilePicUrl: acc.profilePicUrl
        });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ activeAccountId, accounts: data }, null, 2));
}

function loadAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
        if (raw.accounts && Array.isArray(raw.accounts)) {
            for (const acc of raw.accounts) {
                if (acc.email && (!acc.label || acc.label.startsWith('Account '))) {
                    acc.label = acc.email;
                }
                accounts.set(acc.id, {
                    ...acc,
                    userDataDir: path.join(BROWSER_DATA_DIR, acc.id)
                });
            }
        }
        if (raw.activeAccountId && accounts.has(raw.activeAccountId)) {
            activeAccountId = raw.activeAccountId;
        }
    } catch (err) {
        log('Warning: Failed to load accounts.json - ' + err.message);
    }
}

// --- Cookie Extraction ---

async function getAllCookies(page) {
    try {
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        return cookies;
    } catch (e) {
        return await page.cookies();
    }
}

/**
 * Launch a headless browser with the account's userDataDir and extract cookies
 * for labs.google domain.
 */
async function extractCookies(accountId, { silent = false } = {}) {
    const acc = accounts.get(accountId);
    if (!acc) throw new Error('Account ' + accountId + ' not found');

    let browser;
    try {
        ensureProfileUsable(acc.userDataDir);

        try {
            browser = await puppeteer.launch({
                headless: 'shell',
                executablePath: config.CHROME_EXECUTABLE_PATH,
                userDataDir: acc.userDataDir,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--window-position=-2400,-2400',
                    '--window-size=10,10'
                ]
            });
        } catch (err) {
            if (acc.cookies) {
                if (!silent) log('Cookies for "' + acc.label + '" reused (browser locked)');
                return acc.cookies;
            }
            throw err;
        }

        const page = await browser.newPage();
        await page.setUserAgent(config.DEFAULT_HEADERS['user-agent']);

        try {
            await page.goto(LABS_URL + LABS_FLOW_PATH, {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
            await new Promise(r => setTimeout(r, 3000));
        } catch (navErr) {
            // Still try to extract cookies even if navigation had issues
        }

        // Check if redirected to login
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            acc.status = 'expired';
            saveAccounts();
            throw new Error('session expired (redirected to login)');
        }

        // Auto-detect Project ID from URL
        if (currentUrl.includes('/project/')) {
            const projectMatch = currentUrl.match(/\/project\/([a-f0-9-]{20,})/i);
            if (projectMatch) {
                acc.projectId = projectMatch[1];
            }
        }

        // Extract all cookies
        const cookies = await getAllCookies(page);
        acc.rawCookies = cookies;
        const cookieParts = cookies
            .filter(c => c.domain.includes('google'))
            .map(c => c.name + '=' + c.value);
        const cookieString = cookieParts.join('; ');

        // Update account
        acc.cookies = cookieString;
        acc.status = 'valid';
        acc.lastRefresh = new Date().toISOString();

        // Try to detect email if not already set
        if (!acc.email) {
            try {
                await page.goto('https://myaccount.google.com/personal-info', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                await new Promise(r => setTimeout(r, 2000));

                const email = await page.evaluate(() => {
                    var text = document.body ? document.body.innerText : '';
                    var match = text.match(/[\w.-]+@(gmail|googlemail|google)\.[\w.]+/i);
                    if (match) return match[0];
                    var ariaEls = document.querySelectorAll('[aria-label*="@"]');
                    for (var i = 0; i < ariaEls.length; i++) {
                        var m = ariaEls[i].getAttribute('aria-label').match(/[\w.-]+@[\w.-]+\.\w{2,}/);
                        if (m) return m[0];
                    }
                    return null;
                });
                if (email) {
                    acc.email = email;
                    acc.label = email;
                }
            } catch (e) { /* Email detection failed — not critical */ }
        }
        
        // Detect Google One status
        await detectGoogleOne(accountId).catch(() => {});

        saveAccounts();
        if (!silent) log('Cookies for "' + acc.label + '" success extracted');
        return cookieString;
    } catch (err) {
        if (!silent) log('Cookies for "' + (acc.label || accountId) + '" fail extracted: ' + err.message);
        throw err;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }
}

// --- Account Management ---

/**
 * Add a new account by opening a non-headless browser for manual login.
 */
async function addAccount(label) {
    const id = generateId();
    const userDataDir = path.join(BROWSER_DATA_DIR, id);
    ensureDir(userDataDir);

    const acc = {
        id,
        label: label || 'Account ' + (accounts.size + 1),
        email: '',
        userDataDir,
        status: 'logging-in',
        lastRefresh: null,
        lastUsed: null,
        cookies: ''
    };
    accounts.set(id, acc);
    saveAccounts();

    log('Opening browser for new account "' + acc.label + '"...');

    ensureProfileUsable(userDataDir);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: config.CHROME_EXECUTABLE_PATH,
            userDataDir: userDataDir,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--start-maximized'
            ]
        });
    } catch (err) {
        log('Error launching browser: ' + err.message);
        acc.status = 'unknown';
        saveAccounts();
        return acc;
    }

    const targetUrl = LABS_URL + LABS_FLOW_PATH;

    try {
        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());
        await page.setUserAgent(config.DEFAULT_HEADERS['user-agent']);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        log('Navigation warning (non-fatal): ' + err.message);
    }

    // Poll the LIVE browser to detect login & capture cookies
    return new Promise((resolve) => {
        let cookiesCaptured = false;
        let pollTimer = null;
        let resolved = false;

        const finish = async () => {
            if (resolved) return;
            resolved = true;
            if (pollTimer) clearInterval(pollTimer);
            if (browser.isConnected()) {
                try { await browser.close(); } catch (e) {}
            }
            resolve(acc);
        };

        pollTimer = setInterval(async () => {
            try {
                if (!browser.isConnected()) { await finish(); return; }
                const pages = await browser.pages();
                if (pages.length === 0) return;

                const activePage = pages[pages.length - 1];
                const url = activePage.url();

                if (!cookiesCaptured && url.includes('labs.google')
                    && !url.includes('accounts.google')
                    && !url.includes('signin')) {

                    const pageCookies = await getAllCookies(activePage);
                    const hasSessionCookie = pageCookies.some(c =>
                        c.name === '__Secure-next-auth.session-token' && c.value.length > 10
                    );
                    if (!hasSessionCookie) return;

                    cookiesCaptured = true;
                    if (pollTimer) clearInterval(pollTimer);

                    log('Login berhasil terdeteksi! URL: ' + url);

                    // Auto-detect Project ID
                    const projectMatch = url.match(/\/project\/([a-f0-9-]{20,})/i);
                    if (projectMatch) {
                        acc.projectId = projectMatch[1];
                    }

                    // Extract cookies from the LIVE browser
                    acc.rawCookies = pageCookies;
                    const cookieParts = pageCookies
                        .filter(c => c.domain.includes('google'))
                        .map(c => c.name + '=' + c.value);
                    acc.cookies = cookieParts.join('; ');
                    acc.status = 'valid';
                    acc.lastRefresh = new Date().toISOString();

                    // Try detect email from JWT
                    try {
                        const sessionCookie = pageCookies.find(c => c.name === '__Secure-next-auth.session-token');
                        if (sessionCookie && sessionCookie.value) {
                            const parts = sessionCookie.value.split('.');
                            if (parts.length >= 2) {
                                const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
                                const jwtData = JSON.parse(payload);
                                if (jwtData.email) acc.email = jwtData.email;
                            }
                        }
                    } catch (e) { /* JWT decode failed */ }

                    // Method 2: check page for email
                    if (!acc.email) {
                        try {
                            const email = await activePage.evaluate(() => {
                                var ariaEls = document.querySelectorAll('[aria-label*="@"]');
                                for (var i = 0; i < ariaEls.length; i++) {
                                    var m = ariaEls[i].getAttribute('aria-label').match(/[\w.-]+@[\w.-]+\.\w{2,}/);
                                    if (m) return m[0];
                                }
                                return null;
                            });
                            if (email) acc.email = email;
                        } catch (e) { /* ignore */ }
                    }

                    if (acc.email) acc.label = acc.email;
                    
                    // Fetch profile info and Google One status immediately with retries if email is missing
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            log(`Mengambil info profil/Google One (percobaan ${attempt}/3)...`);
                            await detectGoogleOne(acc.id);
                            if (acc.email) {
                                log(`Info profil berhasil didapatkan! Email: ${acc.email}`);
                                break;
                            }
                        } catch (err) {
                            log(`Percobaan ${attempt} gagal: ${err.message}`);
                        }
                        if (attempt < 3 && !acc.email) {
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }

                    if (acc.email) acc.label = acc.email;
                    saveAccounts();
                    log('Account "' + acc.label + '" siap! (' + (acc.email || 'email unknown') + ')');

                    // Fetch Project ID in background (fire and forget)
                    setTimeout(async () => {
                        try {
                            const pid = await fetchProjectId(acc.id);
                            log('  ✓ Project ID: ' + pid);
                        } catch (e) {
                            log('  Project ID fetch gagal: ' + e.message);
                        }
                    }, 2000);

                    await finish();
                }
            } catch (e) { /* Browser might be closing */ }
        }, 3000);

        // When browser is closed by user
        browser.on('disconnected', async () => {
            if (resolved) return;
            log('Browser ditutup oleh user.');
            if (cookiesCaptured) {
                log('Account "' + acc.label + '" sudah tersimpan dengan cookies valid.');
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await detectGoogleOne(id);
                        if (acc.email) break;
                    } catch (e) {}
                    if (attempt < 3 && !acc.email) {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            } else {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    await extractCookies(id);
                } catch (e) {
                    acc.status = 'expired';
                    saveAccounts();
                }
            }
            await finish();
        });

        // Safety timeout: 15 minutes
        setTimeout(async () => {
            if (browser.isConnected()) {
                log('Timeout 15 menit - menutup browser...');
                await finish();
            }
        }, 15 * 60 * 1000);
    });
}

/**
 * Remove an account and delete its browser data
 */
function removeAccount(accountId, deleteBrowserData = true) {
    const acc = accounts.get(accountId);
    if (!acc) throw new Error('Account ' + accountId + ' not found');

    const wasActive = activeAccountId === accountId;
    accounts.delete(accountId);

    if (wasActive) {
        const firstKey = accounts.keys().next().value;
        activeAccountId = firstKey || null;
    }

    if (deleteBrowserData) {
        const browserDir = path.join(BROWSER_DATA_DIR, accountId);
        if (fs.existsSync(browserDir)) {
            try {
                fs.rmSync(browserDir, { recursive: true, force: true });
                log('Deleted browser data for "' + acc.label + '"');
            } catch (e) {
                log('Warning: Could not delete browser data - ' + e.message);
            }
        }
    }

    saveAccounts();
    log('Removed account "' + acc.label + '" (' + accountId + ')');
}

/**
 * Clean up orphan browser-data folders
 */
function cleanOrphanBrowserData() {
    if (!fs.existsSync(BROWSER_DATA_DIR)) return;
    const dirs = fs.readdirSync(BROWSER_DATA_DIR);
    let cleaned = 0;
    for (const dir of dirs) {
        const fullPath = path.join(BROWSER_DATA_DIR, dir);
        if (!fs.statSync(fullPath).isDirectory()) continue;
        if (!accounts.has(dir)) {
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                log('Cleaned orphan browser data: ' + dir);
                cleaned++;
            } catch (e) { /* ignore */ }
        }
    }
    if (cleaned > 0) log('Cleaned ' + cleaned + ' orphan browser data folder(s)');
}

/**
 * List all accounts (safe for API response — no cookies exposed)
 */
function listAccounts() {
    const result = [];
    for (const [id, acc] of accounts) {
        result.push({
            id: acc.id,
            label: acc.label,
            email: acc.email,
            status: acc.status,
            busy: !!acc.busy,
            lastRefresh: acc.lastRefresh,
            lastUsed: acc.lastUsed,
            isActive: acc.id === activeAccountId,
            hasCookies: !!acc.cookies,
            projectId: acc.projectId || null,
            googleOneTier: acc.googleOneTier || null,
            profilePicUrl: acc.profilePicUrl || null
        });
    }
    return result;
}

/**
 * Set the active account
 */
function setActiveAccount(accountId) {
    if (!accounts.has(accountId)) throw new Error('Account ' + accountId + ' not found');
    activeAccountId = accountId;
    saveAccounts();
    const acc = accounts.get(accountId);
    log('Active account set to "' + acc.label + '"');
}

// --- Cookie Retrieval for API Calls ---

function getActiveCookies() {
    if (accounts.size === 0) return null;
    if (activeAccountId && accounts.has(activeAccountId)) {
        const acc = accounts.get(activeAccountId);
        if (acc.cookies && acc.status === 'valid') {
            acc.lastUsed = new Date().toISOString();
            return acc.cookies;
        }
    }
    if (roundRobinEnabled) {
        const validAccounts = Array.from(accounts.values()).filter(a => a.cookies && a.status === 'valid');
        if (validAccounts.length === 0) return null;
        roundRobinIndex = roundRobinIndex % validAccounts.length;
        const acc = validAccounts[roundRobinIndex];
        roundRobinIndex++;
        acc.lastUsed = new Date().toISOString();
        return acc.cookies;
    }
    return null;
}

/**
 * Acquire an account for a generation session (round-robin, skip busy).
 */
function acquireAccount() {
    if (roundRobinEnabled) {
        const validAccounts = Array.from(accounts.values()).filter(
            a => a.cookies && a.status === 'valid' && !a.busy
        );
        if (validAccounts.length === 0) {
            const anyValid = Array.from(accounts.values()).filter(a => a.cookies && a.status === 'valid');
            if (anyValid.length === 0) return null;
            anyValid.sort((a, b) => (a.lastUsed || '').localeCompare(b.lastUsed || ''));
            const acc = anyValid[0];
            acc.busy = true;
            acc.lastUsed = new Date().toISOString();
            log('⚠️ All accounts busy — reusing "' + acc.label + '"');
            return {
                id: acc.id, label: acc.label, email: acc.email,
                cookies: acc.cookies,
                projectId: acc.projectId || config.PROJECT_ID,
                browserDataDir: path.join(BROWSER_DATA_DIR, acc.id)
            };
        }
        roundRobinIndex = roundRobinIndex % validAccounts.length;
        const acc = validAccounts[roundRobinIndex];
        roundRobinIndex++;
        acc.busy = true;
        acc.lastUsed = new Date().toISOString();
        log('🔄 Acquired account "' + acc.label + '"');
        return {
            id: acc.id, label: acc.label, email: acc.email,
            cookies: acc.cookies,
            projectId: acc.projectId || config.PROJECT_ID,
            browserDataDir: path.join(BROWSER_DATA_DIR, acc.id)
        };
    }

    // Round-robin OFF: always use active account
    if (activeAccountId && accounts.has(activeAccountId)) {
        const acc = accounts.get(activeAccountId);
        if (acc.cookies && acc.status === 'valid') {
            acc.busy = true;
            acc.lastUsed = new Date().toISOString();
            return {
                id: acc.id, label: acc.label, email: acc.email,
                cookies: acc.cookies,
                projectId: acc.projectId || config.PROJECT_ID,
                browserDataDir: path.join(BROWSER_DATA_DIR, acc.id)
            };
        }
    }

    const anyValid = Array.from(accounts.values()).filter(a => a.cookies && a.status === 'valid');
    if (anyValid.length === 0) return null;
    const acc = anyValid[0];
    acc.busy = true;
    acc.lastUsed = new Date().toISOString();
    return {
        id: acc.id, label: acc.label, email: acc.email,
        cookies: acc.cookies,
        projectId: acc.projectId || config.PROJECT_ID,
        browserDataDir: path.join(BROWSER_DATA_DIR, acc.id)
    };
}

function releaseAccount(accountId) {
    if (accounts.has(accountId)) {
        accounts.get(accountId).busy = false;
    }
}

function getActiveAccountInfo(accountId) {
    if (accountId && accounts.has(accountId)) {
        const acc = accounts.get(accountId);
        return { id: acc.id, label: acc.label, email: acc.email };
    }
    if (activeAccountId && accounts.has(activeAccountId)) {
        const acc = accounts.get(activeAccountId);
        return { id: acc.id, label: acc.label, email: acc.email };
    }
    return null;
}

/**
 * Get the browser-data directory for a specific account.
 */
function getAccountProfileDir(accountId) {
    const acc = accounts.get(accountId);
    if (!acc) return null;
    return path.join(BROWSER_DATA_DIR, acc.id);
}

// --- Health Check ---

async function checkHealth(accountId) {
    const acc = accounts.get(accountId);
    if (!acc) throw new Error('Account ' + accountId + ' not found');

    log('Health check for "' + acc.label + '"...');
    ensureProfileUsable(acc.userDataDir);

    const browser = await puppeteer.launch({
        headless: 'shell',
        executablePath: config.CHROME_EXECUTABLE_PATH,
        userDataDir: acc.userDataDir,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-position=-2400,-2400',
            '--window-size=10,10'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(config.DEFAULT_HEADERS['user-agent']);
        await page.goto(LABS_URL + LABS_FLOW_PATH, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        const currentUrl = page.url();
        const isValid = currentUrl.includes('labs.google') &&
            !currentUrl.includes('accounts.google.com') &&
            !currentUrl.includes('signin');

        if (isValid) {
            const cookies = await getAllCookies(page);
            acc.rawCookies = cookies;
            const cookieParts = cookies
                .filter(c => c.domain.includes('google'))
                .map(c => c.name + '=' + c.value);
            acc.cookies = cookieParts.join('; ');
            acc.status = 'valid';
            acc.lastRefresh = new Date().toISOString();
            log('Account "' + acc.label + '" - session valid');
            
            // Detect Google One status
            await detectGoogleOne(accountId).catch(() => {});
        } else {
            acc.status = 'expired';
            acc.googleOneTier = 'Unknown (Expired)';
            log('Account "' + acc.label + '" - session expired');
        }

        saveAccounts();
        return { accountId, status: acc.status, lastRefresh: acc.lastRefresh, googleOneTier: acc.googleOneTier };
    } finally {
        await browser.close();
    }
}

async function checkAllHealth() {
    const results = [];
    for (const [id] of accounts) {
        try {
            const result = await checkHealth(id);
            results.push(result);
        } catch (err) {
            results.push({ accountId: id, status: 'error', error: err.message });
        }
    }
    return results;
}

// --- Keep-Alive ---

function startKeepAlive(intervalMs) {
    const interval = intervalMs || KEEP_ALIVE_INTERVAL_MS;
    if (keepAliveTimer) clearInterval(keepAliveTimer);

    keepAliveTimer = setInterval(async () => {
        let ok = 0, failed = 0;
        const failedLabels = [];
        for (const [id, acc] of accounts) {
            if (acc.status === 'expired' || acc.status === 'logging-in') continue;
            try {
                await extractCookies(id, { silent: true });
                ok += 1;
            } catch (err) {
                failed += 1;
                failedLabels.push(`${acc.label} (${err.message})`);
            }
        }
        let summary = `Keep-alive: ${ok} berhasil, ${failed} gagal`;
        if (failed > 0) summary += ` — gagal: ${failedLabels.join('; ')}`;
        log(summary);
    }, interval);
}

function stopKeepAlive() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

function isKeepAliveRunning() {
    return !!keepAliveTimer;
}

// --- Helper to follow redirects while preserving cookies in Axios ---

function getCookieStringForUrl(url, acc) {
    if (!acc) return '';
    if (Array.isArray(acc.rawCookies)) {
        try {
            const parsedUrl = new URL(url);
            const host = parsedUrl.hostname;
            const matchedCookies = acc.rawCookies.filter(cookie => {
                const domain = cookie.domain;
                if (domain.startsWith('.')) {
                    const suffix = domain.slice(1);
                    return host === suffix || host.endsWith('.' + suffix);
                }
                return host === domain;
            });
            if (matchedCookies.length > 0) {
                return matchedCookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
        } catch (e) {
            // fallback
        }
    }
    return acc.cookies || '';
}

async function fetchWithCookies(url, acc, depth = 0) {
    if (depth > 5) throw new Error('Too many redirects');

    const cookieString = getCookieStringForUrl(url, acc);

    const response = await axios.get(url, {
        headers: {
            'Cookie': cookieString,
            'User-Agent': config.DEFAULT_HEADERS['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    if (response.status >= 300 && response.status < 400) {
        let redirectUrl = response.headers['location'];
        if (!redirectUrl) {
            return { status: response.status, data: response.data, finalUrl: url };
        }

        // Handle relative URLs
        if (redirectUrl.startsWith('/')) {
            const parsedUrl = new URL(url);
            redirectUrl = parsedUrl.origin + redirectUrl;
        }

        return fetchWithCookies(redirectUrl, acc, depth + 1);
    }

    return { status: response.status, data: response.data, finalUrl: url };
}

// --- Detect Google One Tier and Profile Info via direct HTTP requests ---

async function detectGoogleOne(accountId) {
    const acc = accounts.get(accountId);
    if (!acc || !acc.cookies) return 'Free (15 GB)';

    try {
        log('Fetching profile info for "' + acc.label + '"...');
        
        // 1. Fetch myaccount.google.com for email & profile pic
        const profileResult = await fetchWithCookies('https://myaccount.google.com/', acc);

        // Check if final URL/redirect URL points to signin
        const finalUrl = profileResult.finalUrl;
        if (finalUrl.includes('signin') || finalUrl.includes('ServiceLogin') || finalUrl.includes('InteractiveLogin')) {
            log('Google One check: session seems expired for "' + acc.label + '" (profile redirect: ' + finalUrl + ')');
            acc.status = 'expired';
            acc.googleOneTier = 'Unknown (Expired)';
            saveAccounts();
            return 'Unknown (Expired)';
        }

        const profileHtml = profileResult.data;

        // Extract email
        const emailMatch = profileHtml.match(/[\w.-]+@(gmail|googlemail|google)\.[\w.]+/i);
        if (emailMatch) {
            acc.email = emailMatch[0];
            acc.label = emailMatch[0]; // Set label directly to email
        }

        // Extract profile pic
        const picMatches = profileHtml.match(/https:\/\/[a-z0-9-.]+\.googleusercontent\.com\/[a-zA-Z0-9_\-\/=\+]+/gi) || [];
        let profilePic = null;
        for (const url of picMatches) {
            if (url.includes('/a/') || url.includes('/ogw/') || url.includes('/a-/')) {
                profilePic = url;
                break;
            }
        }
        if (!profilePic && picMatches.length > 0) {
            profilePic = picMatches[0];
        }
        if (profilePic) {
            acc.profilePicUrl = profilePic;
        }

        // 2. Fetch one.google.com/storage for Google One tier
        log('Detecting Google One tier for "' + acc.label + '"...');
        const storageResult = await fetchWithCookies('https://one.google.com/storage', acc);

        const finalStorageUrl = storageResult.finalUrl;
        if (finalStorageUrl.includes('signin') || finalStorageUrl.includes('ServiceLogin') || finalStorageUrl.includes('InteractiveLogin')) {
            log('Google One check: session seems expired for "' + acc.label + '" (storage redirect: ' + finalStorageUrl + ')');
            acc.status = 'expired';
            acc.googleOneTier = 'Unknown (Expired)';
            saveAccounts();
            return 'Unknown (Expired)';
        }

        const html = storageResult.data;
        let tier = 'Free (15 GB)';
        const storageMatch = html.match(/\d+(?:\.\d+)?\s*(?:GB|TB|MB)\s+(?:dari|of|de|sur|out\s+of|\/)\s+(\d+\s*(?:GB|TB))/i);
        let parsedLimit = null;
        if (storageMatch) {
            parsedLimit = storageMatch[1].replace(/\s+/g, '').toUpperCase();
        }

        if (parsedLimit) {
            const num = parseInt(parsedLimit, 10);
            const isTB = parsedLimit.includes('TB');
            if (isTB) {
                if (num === 2) tier = 'Premium / AI Premium (2 TB)';
                else if (num === 5) tier = 'Premium (5 TB)';
                else if (num === 10) tier = 'Premium (10 TB)';
                else if (num === 20) tier = 'Premium (20 TB)';
                else if (num === 30) tier = 'Premium (30 TB)';
                else tier = `Premium (${num} TB)`;
            } else {
                if (num === 100) tier = 'Basic (100 GB)';
                else if (num === 200) tier = 'Standard (200 GB)';
                else if (num >= 100) tier = `Premium (${num} GB)`;
                else tier = 'Free (15 GB)';
            }
        } else {
            tier = acc.googleOneTier && acc.googleOneTier !== 'Unknown (Expired)' ? acc.googleOneTier : 'Free (15 GB)';
        }

        acc.googleOneTier = tier;
        saveAccounts();
        log('Google One info updated for "' + acc.label + '". Tier: ' + tier);
        return tier;
    } catch (e) {
        log('Failed to fetch profile/Google One info for "' + acc.label + '": ' + e.message);
        return acc.googleOneTier || 'Free (15 GB)';
    }
}

// --- Fetch/Create Project ID via API ---

async function fetchProjectId(accountId) {
    const axios = require('axios');
    const accId = accountId || activeAccountId;
    const acc = accounts.get(accId);
    if (!acc) throw new Error('Account not found: ' + accId);
    if (acc.projectId) return acc.projectId;
    if (!acc.cookies) throw new Error('Account has no cookies');

    log('Fetching Project ID via API untuk "' + acc.label + '"...');

    const baseUrl = config.LABS_BASE_URL;
    const headers = {
        ...config.DEFAULT_HEADERS,
        'content-type': 'application/json',
        'cookie': acc.cookies,
        'referer': baseUrl + '/fx/id/tools/flow',
        'origin': baseUrl
    };

    // Step 1: Try to find existing project
    try {
        const listUrl = baseUrl + '/fx/api/trpc/project.listProjects?input=' +
            encodeURIComponent(JSON.stringify({ json: { toolName: 'PINHOLE' } }));
        const listRes = await axios.get(listUrl, { headers, timeout: 15000, validateStatus: () => true });

        if (listRes.status >= 200 && listRes.status < 300) {
            let projects = null;
            if (listRes.data?.result?.data?.json) projects = listRes.data.result.data.json;
            else if (Array.isArray(listRes.data?.result?.data)) projects = listRes.data.result.data;

            if (projects && Array.isArray(projects)) {
                for (const proj of projects) {
                    const title = proj.projectTitle || proj.title || proj.name || '';
                    const projId = proj.projectId || proj.id || '';
                    if (title === 'Flow Project' && projId) {
                        acc.projectId = projId;
                        saveAccounts();
                        log('✓ Found existing "Flow Project"! Project ID: ' + projId);
                        return projId;
                    }
                }
            }
        }
    } catch (e) {
        log('  List projects failed: ' + e.message);
    }

    // Step 2: Try flow page redirect
    try {
        const pageRes = await axios.get(baseUrl + '/fx/id/tools/flow', {
            headers: { ...headers, 'accept': 'text/html' },
            timeout: 15000, maxRedirects: 5, validateStatus: () => true
        });
        const finalUrl = pageRes.request?.res?.responseUrl;
        if (finalUrl) {
            const m = finalUrl.match(/\/project\/([a-f0-9-]{20,})/i);
            if (m) {
                acc.projectId = m[1];
                saveAccounts();
                log('✓ Project ID dari redirect: ' + m[1]);
                return m[1];
            }
        }
    } catch (e) { /* ignore */ }

    // Step 3: Create new project
    try {
        const createRes = await axios.post(
            baseUrl + '/fx/api/trpc/project.createProject',
            { json: { toolName: 'PINHOLE', projectTitle: 'Flow Project' } },
            { headers, timeout: 15000, validateStatus: () => true }
        );
        const createBody = typeof createRes.data === 'string' ? createRes.data : JSON.stringify(createRes.data);
        if (createRes.status >= 200 && createRes.status < 300) {
            const pidMatch = createBody.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (pidMatch) {
                acc.projectId = pidMatch[1];
                saveAccounts();
                log('✓ Created new "Flow Project"! Project ID: ' + pidMatch[1]);
                return pidMatch[1];
            }
        }
    } catch (e) { /* ignore */ }

    throw new Error('Could not find/create Project ID via API.');
}

// --- Add Account via Cookies ---

async function addCookieAccount(cookiesString) {
    if (!cookiesString) throw new Error('Cookies required');

    let email = null;
    try {
        const match = cookiesString.match(/(?:^|;\s*)__Secure-next-auth\.session-token=([^;]+)/);
        if (match) {
            const parts = match[1].split('.');
            if (parts.length >= 2) {
                const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
                const jwtData = JSON.parse(payload);
                if (jwtData.email) email = jwtData.email;
            }
        }
    } catch (e) { /* JWT decode failed */ }

    // Update existing account if email matches
    if (email) {
        for (const [id, a] of accounts) {
            if (a.email === email) {
                a.cookies = cookiesString;
                a.status = 'valid';
                a.lastRefresh = new Date().toISOString();
                
                await detectGoogleOne(id).catch(() => {});
                
                saveAccounts();
                log('Updated account "' + a.label + '" with new cookies.');
                setTimeout(() => { fetchProjectId(id).catch(() => {}); }, 2000);
                return a;
            }
        }
    }

    const id = generateId();
    const userDataDir = path.join(BROWSER_DATA_DIR, id);
    ensureDir(userDataDir);

    const acc = {
        id,
        label: email || 'Account ' + (accounts.size + 1),
        email: email || '',
        userDataDir,
        status: 'valid',
        lastRefresh: new Date().toISOString(),
        lastUsed: null,
        cookies: cookiesString
    };

    accounts.set(id, acc);
    
    await detectGoogleOne(id).catch(() => {});
    
    saveAccounts();
    log('Added new cookie account "' + acc.label + '"');

    setTimeout(() => { fetchProjectId(id).catch(() => {}); }, 2000);
    return acc;
}

// --- Round-Robin Toggle ---

function setRoundRobin(enabled) {
    roundRobinEnabled = !!enabled;
    roundRobinIndex = 0;
    log('Round-robin mode: ' + (roundRobinEnabled ? 'ON 🔄' : 'OFF 🔒'));
}

function isRoundRobinEnabled() {
    return roundRobinEnabled;
}

// --- Initialization ---

function init() {
    ensureDir(BROWSER_DATA_DIR);
    loadAccounts();
    cleanOrphanBrowserData();

    if (accounts.size > 0) {
        const mins = Math.round(KEEP_ALIVE_INTERVAL_MS / 60000);
        log(`Loaded ${accounts.size} account(s); keep-alive every ${mins} min`);
        startKeepAlive();
    } else {
        log('No saved accounts. Use "Add Account" to get started.');
    }
}

function getAccountCount() { return accounts.size; }
function hasValidAccounts() {
    for (const [, acc] of accounts) {
        if (acc.status === 'valid' && acc.cookies) return true;
    }
    return false;
}

// --- Exports ---

module.exports = {
    init,
    addAccount,
    addCookieAccount,
    removeAccount,
    listAccounts,
    setActiveAccount,
    getActiveCookies,
    acquireAccount,
    releaseAccount,
    getActiveAccountInfo,
    getAccountProfileDir,
    extractCookies,
    fetchProjectId,
    detectGoogleOne,
    checkHealth,
    checkAllHealth,
    startKeepAlive,
    stopKeepAlive,
    isKeepAliveRunning,
    getAccountCount,
    hasValidAccounts,
    saveAccounts,
    cleanOrphanBrowserData,
    setRoundRobin,
    isRoundRobinEnabled
};
