const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const { getLabsCookies, parseCookies } = require('./cookies');
const browserRegistry = require('./browser-registry');
function ensureProfileUsable(profileDir) {
    if (!profileDir || !fs.existsSync(profileDir)) return;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(profileDir, f)); } catch (e) {}
    }
}

// Apply stealth plugin — hides headless browser signals from Google
puppeteer.use(StealthPlugin());

/**
 * Get the browser data directory for a specific account (or active account).
 * Falls back to null if not found.
 */
function getAccountUserDataDir(accountId) {
    try {
        const fs = require('fs');
        const baseDir = path.join(__dirname, '..', 'browser-data');

        // If specific accountId provided, use that
        if (accountId) {
            const dir = path.join(baseDir, accountId);
            if (fs.existsSync(dir)) return dir;
        }

        // Fallback: try active account from session manager
        const sm = require('./session-manager');
        const info = sm.getActiveAccountInfo();
        if (info && info.id) {
            const dir = path.join(baseDir, info.id);
            if (fs.existsSync(dir)) return dir;
        }
    } catch (e) { }
    return null;
}

/**
 * Solve reCAPTCHA Enterprise menggunakan Puppeteer + Stealth
 * 
 * Strategy:
 *   1. puppeteer-extra-plugin-stealth → hide automation signals
 *   2. Non-headless mode with visible window → higher trust score
 *   3. Use Session Manager browser profile (userDataDir) → Google login history
 *   4. Fallback: fresh browser with cookies set manually
 */
async function solveRecaptcha(onStatus, action = 'IMAGE_GENERATION', options = {}) {
    // 2Captcha Priority — skip if forcePuppeteer is set (e.g. after reCAPTCHA rejection)
    if (!options.forcePuppeteer && config.TWOCAPTCHA_API_KEY && config.TWOCAPTCHA_API_KEY !== 'YOUR_2CAPTCHA_API_KEY_HERE') {
        if (onStatus) onStatus('[Captcha] Attempting to solve reCAPTCHA Enterprise using 2Captcha API...');
        try {
            const createRes = await axios.post(config.TWOCAPTCHA_CREATE_URL, {
                clientKey: config.TWOCAPTCHA_API_KEY,
                task: {
                    type: "RecaptchaV2EnterpriseTaskProxyless",
                    websiteURL: config.RECAPTCHA_WEBSITE_URL,
                    websiteKey: config.RECAPTCHA_SITE_KEY,
                    pageAction: action
                }
            });

            if (createRes.data.errorId !== 0) {
                throw new Error('2Captcha create error: ' + JSON.stringify(createRes.data));
            }

            const taskId = createRes.data.taskId;
            if (onStatus) onStatus(`[Captcha] 2Captcha Task created (ID: ${taskId}). Waiting for result...`);
            
            for (let i = 0; i < 24; i++) {
                await new Promise(r => setTimeout(r, 5000));
                const res = await axios.post(config.TWOCAPTCHA_RESULT_URL, {
                    clientKey: config.TWOCAPTCHA_API_KEY,
                    taskId: taskId
                });
                
                if (res.data.status === 'ready') {
                    if (onStatus) onStatus(`[Captcha] ✓ 2Captcha solved successfully!`);
                    return res.data.solution.gRecaptchaResponse;
                } else if (res.data.errorId !== 0) {
                    throw new Error('2Captcha result error: ' + JSON.stringify(res.data));
                }
            }
            throw new Error('2Captcha timeout waiting for solution');
        } catch (err) {
            if (onStatus) onStatus('[Captcha] 2Captcha failed: ' + err.message + ' — falling back to Puppeteer...');
        }
    }

    const userDataDir = getAccountUserDataDir(options.accountId);
    const useProfile = !!userDataDir;

    if (onStatus) onStatus(`[Captcha] Strategy: Stealth + ${useProfile ? 'Session profile (' + path.basename(userDataDir) + ')' : 'Fresh browser + cookies'}`);
    const isHeadless = config.HEADLESS !== false;
    if (onStatus) onStatus(`[Captcha] Launching browser (headless=${isHeadless})...`);

    const launchOptions = {
        headless: config.HEADLESS,
        executablePath: config.CHROME_EXECUTABLE_PATH,  // Use real Chrome (not bundled Chromium)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-popup-blocking',
            '--disable-extensions',
            '--mute-audio'
        ]
    };

    // Use session profile if available (better reCAPTCHA scores).
    if (useProfile) {
        launchOptions.userDataDir = userDataDir;
        // Cleanup orphans BEFORE launching. The captcha solver is a hot
        // path (every generation call) so any orphan from a previous solve
        // would block the pipeline indefinitely with "Failed to launch the
        // browser process! undefined".
        ensureProfileUsable(userDataDir, (msg) => onStatus && onStatus('[Captcha] ' + msg));
    }

    const browser = browserRegistry.register(await puppeteer.launch(launchOptions));

    try {
        const page = await browser.newPage();
        await page.setUserAgent(config.DEFAULT_HEADERS['user-agent']);
        await page.setViewport({ width: 1920, height: 1080 });

        // NOTE: Do NOT use page.setRequestInterception or CDP Fetch — it interferes with reCAPTCHA scoring!

        // If NOT using profile, manually set cookies
        if (!useProfile) {
            const cookieStr = options.cookies || getLabsCookies();
            if (!cookieStr) throw new Error('No Labs cookies configured');

            const cdp = await page.createCDPSession();
            const cookieMap = parseCookies(cookieStr);
            const cdpCookies = [];
            for (const [name, value] of cookieMap) {
                if (!name || !value) continue;
                cdpCookies.push({
                    name: name,
                    value: value,
                    domain: 'labs.google',
                    path: '/',
                    secure: true,
                    httpOnly: false
                });
            }
            if (onStatus) onStatus('[Captcha] Setting ' + cdpCookies.length + ' cookies via CDP...');

            try {
                await cdp.send('Network.setCookies', { cookies: cdpCookies });
            } catch (cdpErr) {
                if (onStatus) onStatus('[Captcha] CDP batch failed, setting cookies individually...');
                for (const [name, value] of cookieMap) {
                    if (!name || !value) continue;
                    try {
                        await page.setCookie({
                            name: name,
                            value: value,
                            url: 'https://labs.google/'
                        });
                    } catch (e) { }
                }
            }
        } else {
            if (onStatus) onStatus('[Captcha] Using existing browser profile (cookies already present)');
        }

        // Open Google Labs Flow page
        const pid = options.projectId || config.PROJECT_ID;
        const projectUrl = pid
            ? config.LABS_BASE_URL + '/fx/id/tools/flow/project/' + pid
            : config.LABS_BASE_URL + '/fx/id/tools/flow';
        if (onStatus) onStatus('[Captcha] Opening: ' + projectUrl);
        await page.goto(projectUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        // Check if page loaded (not redirected to login)
        const currentUrl = page.url();
        if (onStatus) onStatus('[Captcha] Current URL: ' + currentUrl);

        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            throw new Error('Redirected to login — session cookies expired or invalid');
        }

        // Wait for grecaptcha.enterprise
        if (onStatus) onStatus('[Captcha] Waiting for grecaptcha.enterprise...');
        try {
            await page.waitForFunction(
                () => !!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute),
                { timeout: 20000 }
            );
            if (onStatus) onStatus('[Captcha] ✓ grecaptcha.enterprise found');
        } catch (e) {
            // Try to load reCAPTCHA script manually
            if (onStatus) onStatus('[Captcha] grecaptcha not found, injecting reCAPTCHA script...');
            await page.addScriptTag({
                url: 'https://www.google.com/recaptcha/enterprise.js?render=' + config.RECAPTCHA_SITE_KEY
            });
            await page.waitForFunction(
                () => !!(window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute),
                { timeout: 15000 }
            );
            if (onStatus) onStatus('[Captcha] ✓ grecaptcha.enterprise loaded via injection');
        }

        // Execute beforeSolve callback if provided (e.g., upload image from browser).
        // Runs AFTER page load + grecaptcha ready, BEFORE captcha solving.
        // This ensures upload and generation happen in the same browser session.
        if (options.beforeSolve && typeof options.beforeSolve === 'function') {
            if (onStatus) onStatus('[Captcha] Executing pre-solve callback (upload)...');
            await options.beforeSolve(page);
        }

        // Simulate human behavior to improve reCAPTCHA trust score
        if (onStatus) onStatus('[Captcha] Simulating human behavior for better trust score...');
        try {
            // Random mouse movements
            for (let i = 0; i < 5; i++) {
                const x = 200 + Math.floor(Math.random() * 800);
                const y = 200 + Math.floor(Math.random() * 400);
                await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
                await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
            }
            // Small scroll
            await page.evaluate(() => window.scrollBy(0, 100 + Math.floor(Math.random() * 200)));
            await new Promise(r => setTimeout(r, 500));
            await page.evaluate(() => window.scrollBy(0, -(50 + Math.floor(Math.random() * 100))));
        } catch (e) {
            // Non-critical — page might not allow these actions
        }

        // Longer delay — let reCAPTCHA gather more browser signals for higher score
        const waitMs = 3000 + Math.floor(Math.random() * 2000);
        if (onStatus) onStatus('[Captcha] Waiting ' + Math.round(waitMs / 1000) + 's for reCAPTCHA signal gathering...');
        await new Promise(r => setTimeout(r, waitMs));

        // Execute reCAPTCHA Enterprise
        if (onStatus) onStatus('[Captcha] Executing: grecaptcha.enterprise.execute(\'' + config.RECAPTCHA_SITE_KEY + '\', {action: \'' + action + '\'})...');

        const token = await page.evaluate(async (siteKey, captchaAction) => {
            try {
                const g = window.grecaptcha.enterprise;
                const token = await g.execute(siteKey, { action: captchaAction });
                return { success: true, token: token };
            } catch (err) {
                return { success: false, error: err.message || String(err) };
            }
        }, config.RECAPTCHA_SITE_KEY, action);

        if (!token.success) {
            throw new Error('grecaptcha.enterprise.execute failed: ' + token.error);
        }

        if (!token.token || token.token.length < 20) {
            throw new Error('Invalid token returned (length: ' + (token.token ? token.token.length : 0) + ')');
        }

        if (onStatus) onStatus('[Captcha] ✓ reCAPTCHA token acquired! (' + token.token.length + ' chars)');

        // Capture Chrome's dynamic browser headers via CDP
        // These headers (x-client-data, x-browser-*) are auto-added by Chrome
        // and must match the browser that solved the captcha
        try {
            const cdp = await page.createCDPSession();
            await cdp.send('Network.enable');

            const dynamicHeaders = {};
            const headersCaptured = new Promise((resolve) => {
                cdp.on('Network.requestWillBeSentExtraInfo', (params) => {
                    const h = params.headers;
                    if (h['x-client-data']) dynamicHeaders['x-client-data'] = h['x-client-data'];
                    if (h['x-browser-channel']) dynamicHeaders['x-browser-channel'] = h['x-browser-channel'];
                    if (h['x-browser-copyright']) dynamicHeaders['x-browser-copyright'] = h['x-browser-copyright'];
                    if (h['x-browser-validation']) dynamicHeaders['x-browser-validation'] = h['x-browser-validation'];
                    if (h['x-browser-year']) dynamicHeaders['x-browser-year'] = h['x-browser-year'];
                    if (dynamicHeaders['x-client-data']) resolve(dynamicHeaders);
                });
            });

            // Trigger a cross-origin request to googleapis.com from within Chrome
            await page.evaluate((apiUrl) => {
                fetch(apiUrl, { method: 'OPTIONS', mode: 'cors' }).catch(() => {});
            }, config.SANDBOX_API_URL);

            const captured = await Promise.race([
                headersCaptured,
                new Promise(r => setTimeout(() => r(null), 5000))
            ]);

            if (captured && Object.keys(captured).length > 0) {
                config.dynamicBrowserHeaders = captured;
                if (onStatus) onStatus('[Captcha] Captured ' + Object.keys(captured).length + ' dynamic browser headers: ' + Object.keys(captured).join(', '));
            } else {
                if (onStatus) onStatus('[Captcha] No dynamic headers captured (will use static headers)');
            }

            await cdp.detach();
        } catch (e) {
            if (onStatus) onStatus('[Captcha] Header capture skipped: ' + e.message);
        }

        // Execute afterSolve callback within browser context if provided.
        // Used for making API calls from within the browser where the reCAPTCHA
        // was solved, ensuring consistent browser signals (x-client-data, TLS
        // fingerprint) that match the reCAPTCHA token — fixes UNUSUAL_ACTIVITY.
        if (options.afterSolve && typeof options.afterSolve === 'function') {
            if (onStatus) onStatus('[Captcha] Executing API call from within browser...');
            try {
                const callbackResult = await options.afterSolve(page, token.token);
                return { token: token.token, callbackResult };
            } catch (callbackErr) {
                if (onStatus) onStatus('[Captcha] In-browser API call error: ' + callbackErr.message);
                throw callbackErr;
            }
        }

        return token.token;
    } catch (err) {
        if (onStatus) onStatus('[Captcha] ERROR: ' + err.message);
        throw err;
    } finally {
        await browserRegistry.safeClose(browser);
        if (onStatus) onStatus('[Captcha] Browser closed');
    }
}

module.exports = { solveRecaptcha };
