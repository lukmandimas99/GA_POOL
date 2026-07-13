const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { getLabsCookies } = require('./cookies');
const { solveRecaptcha } = require('./captcha');
const sessionManager = require('./session-manager');

/**
 * Generate session ID for Google Flow
 */
function generateSessionId() {
    return ';' + Date.now();
}

/**
 * Helper: truncate string for display
 */
function trunc(str, len = 80) {
    if (!str) return '(empty)';
    str = String(str);
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function maskSecret(secret, visible = 6) {
    const s = String(secret || '');
    if (!s) return '(empty)';
    if (s.length <= visible * 2) return '*'.repeat(s.length);
    return `${s.slice(0, visible)}...${s.slice(-visible)}`;
}

/**
 * Helper: safe JSON stringify for logging
 */
function safeJson(obj) {
    try {
        return JSON.stringify(obj, null, 2);
    } catch (e) {
        return String(obj);
    }
}

/**
 * Helper: axios with auto-retry on 429 (rate limit)
 * Uses exponential backoff: 30s, 60s, 120s
 */
async function axiosWithRetry(axiosFn, maxRetries = 3, onLog, retryOn500 = false) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await axiosFn();
        } catch (err) {
            const status = err.response?.status;
            if (status === 429 && attempt < maxRetries) {
                const retryAfter = err.response?.headers?.['retry-after'];
                const waitSec = retryAfter ? parseInt(retryAfter) : (30 * Math.pow(2, attempt - 1));
                const waitMs = waitSec * 1000;
                if (onLog) onLog(`⚠️ Rate limited (429)! Retry ${attempt}/${maxRetries} in ${waitSec}s...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else if (status === 500 && retryOn500 && attempt < maxRetries) {
                const waitSec = 5 * attempt;
                if (onLog) onLog(`⚠️ Server error (500)! Retry ${attempt}/${maxRetries} in ${waitSec}s...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            } else {
                throw err;
            }
        }
    }
}

/**
 * Check if an error is a reCAPTCHA rejection (403 PERMISSION_DENIED)
 * or a server error (500) where the token was likely consumed
 */
function isRetryableGenerationError(err) {
    if (!err.response) return false;
    const status = err.response.status;
    // 403 = reCAPTCHA token rejected (low score / already consumed)
    if (status === 403) {
        const data = err.response.data;
        const msg = typeof data === 'string' ? data : JSON.stringify(data || '');
        return msg.includes('reCAPTCHA') || msg.includes('PERMISSION_DENIED');
    }
    // 500 = server error — token was likely consumed, can't reuse
    if (status === 500) return true;
    return false;
}

/**
 * Helper: Solve reCAPTCHA and call generation API with automatic retry.
 * Supports two modes:
 *   1. Standard: solve captcha in Puppeteer, then call API from Node.js (generateFn)
 *   2. In-browser: solve captcha AND call API within the same Puppeteer browser (browserGenerateFn)
 *      → Mode 2 ensures TLS fingerprint + x-client-data match, fixing UNUSUAL_ACTIVITY for media.
 * @param {object} opts
 * @param {string} opts.action - reCAPTCHA action (e.g. 'IMAGE_GENERATION')
 * @param {object} opts.solveOptions - options passed to solveRecaptcha (projectId, accountId)
 * @param {function} [opts.generateFn] - async (recaptchaToken) => result (Node.js API call)
 * @param {function} [opts.browserGenerateFn] - async (page, recaptchaToken) => result (in-browser API call)
 * @param {function} opts.log - logging function
 * @param {number} [opts.maxRetries=2] - max attempts
 * @param {boolean} [opts.forcePuppeteerAll=false] - force Puppeteer from first attempt
 */
async function solveAndGenerate({ action, solveOptions, generateFn, browserGenerateFn, log, maxRetries = 2, forcePuppeteerAll = false }) {
    const useInBrowser = !!browserGenerateFn;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const forcePuppeteer = forcePuppeteerAll || attempt > 1;

        if (attempt > 1) {
            const delaySec = 5 + Math.floor(Math.random() * 5);
            log(`⚠️ Generation failed! Retry ${attempt}/${maxRetries} in ${delaySec}s (fresh captcha + Puppeteer)...`);
            await new Promise(r => setTimeout(r, delaySec * 1000));
            log('🔄 Re-solving reCAPTCHA via Puppeteer (higher trust score)...');
        } else {
            log(`⚡ Solving reCAPTCHA (fresh token${forcePuppeteerAll ? ' via Puppeteer' : ''} for immediate use)...`);
        }

        try {
            if (useInBrowser) {
                // === IN-BROWSER MODE ===
                // Solve captcha AND make API call within the same Puppeteer browser.
                // The afterSolve callback runs before the browser closes, ensuring
                // consistent x-client-data and TLS fingerprint.
                const solveResult = await solveRecaptcha(
                    (msg) => log(msg),
                    action,
                    {
                        ...solveOptions,
                        forcePuppeteer,
                        afterSolve: async (page, tokenStr) => {
                            log(`reCAPTCHA Token length: ${tokenStr.length} chars`);
                            log('✓ reCAPTCHA Solved — calling API from BROWSER context ⚡');

                            const jitterMs = 500 + Math.floor(Math.random() * 1500);
                            await new Promise(r => setTimeout(r, jitterMs));

                            return await browserGenerateFn(page, tokenStr);
                        }
                    }
                );
                // solveResult = { token, callbackResult }
                return { recaptchaToken: solveResult.token, result: solveResult.callbackResult };

            } else {
                // === STANDARD MODE (Node.js API call) ===
                let recaptchaToken;
                try {
                    recaptchaToken = await solveRecaptcha(
                        (msg) => log(msg),
                        action,
                        { ...solveOptions, forcePuppeteer }
                    );
                    log(`reCAPTCHA Token length: ${recaptchaToken.length} chars`);
                    log('✓ reCAPTCHA Solved — using IMMEDIATELY ⚡');
                } catch (err) {
                    log(`reCAPTCHA solve ERROR: ${err.message}`);
                    throw err;
                }

                const jitterMs = 500 + Math.floor(Math.random() * 1500);
                await new Promise(r => setTimeout(r, jitterMs));

                try {
                    const result = await generateFn(recaptchaToken);
                    return { recaptchaToken, result };
                } catch (err) {
                    if (isRetryableGenerationError(err) && attempt < maxRetries) {
                        const status = err.response?.status;
                        const errData = err.response ? safeJson(err.response.data) : err.message;
                        log(`⚠️ Generation failed (${status}): ${trunc(errData, 200)}`);
                        continue;
                    }
                    throw err;
                }
            }
        } catch (err) {
            // Handle retryable errors from in-browser mode
            if (useInBrowser && isRetryableGenerationError(err) && attempt < maxRetries) {
                const status = err.response?.status;
                const errData = err.response ? safeJson(err.response.data) : err.message;
                log(`⚠️ Generation failed (${status}): ${trunc(errData, 200)}`);
                continue;
            }
            throw err;
        }
    }
}

/**
 * Make an API call from within a Puppeteer browser page context.
 * Ensures the request has consistent browser signals (x-client-data, TLS fingerprint)
 * matching the reCAPTCHA token solved in the same browser.
 * Resolves "reCAPTCHA evaluation failed / UNUSUAL_ACTIVITY" for media generation.
 */
async function makeInBrowserApiCall(page, url, payload, bearerToken, onLog) {
    if (onLog) onLog(`[InBrowser] POST → ${url.split('/').slice(-2).join('/')}`);

    const bodyStr = JSON.stringify(payload);
    const result = await page.evaluate(async (apiUrl, body, bearer) => {
        try {
            const headers = {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/'
            };
            if (bearer) headers['Authorization'] = 'Bearer ' + bearer;

            const response = await fetch(apiUrl, {
                method: 'POST',
                body: body,
                headers: headers,
                mode: 'cors',
                credentials: 'omit'
            });

            const text = await response.text();
            return { ok: response.ok, status: response.status, body: text };
        } catch (e) {
            return { ok: false, status: 0, body: 'Fetch error: ' + e.message };
        }
    }, url, bodyStr, bearerToken);

    if (onLog) onLog(`[InBrowser] Response status: ${result.status}`);

    if (!result.ok) {
        if (onLog) onLog(`[InBrowser] Error: ${trunc(result.body, 300)}`);
        // Create error compatible with isRetryableGenerationError()
        const err = new Error('Request failed with status code ' + result.status);
        try { err.response = { status: result.status, data: JSON.parse(result.body) }; }
        catch (e) { err.response = { status: result.status, data: result.body }; }
        throw err;
    }

    try {
        return JSON.parse(result.body);
    } catch (e) {
        return result.body;
    }
}

/**
 * Step 1: Search project scenes (prepare/init)
 */
async function searchProjectScenes(projectId, cookies) {
    const input = JSON.stringify({
        json: {
            projectId: projectId,
            toolName: 'PINHOLE',
            pageSize: 10
        }
    });

    const url = `${config.LABS_BASE_URL}/fx/api/trpc/project.searchProjectScenes?input=${encodeURIComponent(input)}`;

    const response = await axios.get(url, {
        headers: {
            ...config.DEFAULT_HEADERS,
            'content-type': 'application/json',
            'referer': `${config.LABS_BASE_URL}/fx/id/tools/flow/project/${projectId}`,
            'cookie': cookies || getLabsCookies()
        }
    });

    return response.data;
}

/**
 * Step 2: Submit batch log event
 */
async function submitBatchLog(projectId, sessionId, cookies) {
    const url = `${config.LABS_BASE_URL}/fx/api/trpc/general.submitBatchLog`;

    const payload = {
        json: {
            appEvents: [{
                event: 'PINHOLE_GENERATE_IMAGE',
                eventMetadata: {
                    sessionId: sessionId
                },
                eventProperties: [
                    { key: 'TOOL_NAME', stringValue: 'PINHOLE' },
                    { key: 'G1_PAYGATE_TIER', stringValue: 'PAYGATE_TIER_ONE' },
                    { key: 'PINHOLE_PROMPT_BOX_MODE', stringValue: 'IMAGE_GENERATION' },
                    { key: 'USER_AGENT', stringValue: config.DEFAULT_HEADERS['user-agent'] },
                    { key: 'IS_DESKTOP' }
                ],
                activeExperiments: [],
                eventTime: new Date().toISOString()
            }]
        }
    };

    const response = await axios.post(url, payload, {
        headers: {
            ...config.DEFAULT_HEADERS,
            'content-type': 'application/json',
            'origin': config.LABS_BASE_URL,
            'referer': `${config.LABS_BASE_URL}/fx/id/tools/flow/project/${projectId}`,
            'cookie': cookies || getLabsCookies()
        }
    });

    return response.data;
}

/**
 * Step 4: CORS preflight for batchGenerateImages
 */
async function preflightBatchGenerate(projectId) {
    const url = `${config.SANDBOX_API_URL}/projects/${projectId}/flowMedia:batchGenerateImages`;

    try {
        const response = await axios({
            method: 'OPTIONS',
            url: url,
            headers: {
                ...config.DEFAULT_HEADERS,
                'access-control-request-headers': 'authorization',
                'access-control-request-method': 'POST',
                'origin': config.LABS_BASE_URL,
                'referer': `${config.LABS_BASE_URL}/`,
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'cross-site'
            }
        });
        return response.status;
    } catch (err) {
        return err.response ? err.response.status : 0;
    }
}

/**
 * Step 6: Generate images with reCAPTCHA token
 */
async function batchGenerateImages(projectId, prompt, recaptchaToken, options = {}) {
    const {
        seed = Math.floor(Math.random() * 999999),
        aspectRatio = 'IMAGE_ASPECT_RATIO_PORTRAIT',
        model = 'GEM_PIX_2',
        imageInputs = [],
        sessionId = generateSessionId(),
        bearerToken = null,
        onLog = null
    } = options;

    const url = `${config.SANDBOX_API_URL}/projects/${projectId}/flowMedia:batchGenerateImages`;

    const clientContext = {
        recaptchaContext: {
            token: recaptchaToken,
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
        },
        sessionId: sessionId,
        projectId: projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_ONE'
    };

    // Only include imageInputs in request if there are actual inputs
    const requestPayload = {
        clientContext: clientContext,
        seed: seed,
        imageModelName: model,
        imageAspectRatio: aspectRatio,
        prompt: prompt
    };

    // Only add imageInputs if non-empty (text-only generation shouldn't send empty array)
    if (imageInputs && imageInputs.length > 0) {
        requestPayload.imageInputs = imageInputs;
        if (onLog) {
            onLog(`[batchGenerate] imageInputs payload: ${JSON.stringify(imageInputs)}`);
        }
    }

    if (onLog) {
        onLog(`[batchGenerate] Full request payload: ${JSON.stringify({ ...requestPayload, clientContext: { ...clientContext, recaptchaContext: { token: '(truncated)', applicationType: clientContext.recaptchaContext.applicationType } } }, null, 0)}`);
    }

    const payload = {
        clientContext: clientContext,
        requests: [requestPayload]
    };

    // Filter out empty CROSS_SITE_HEADERS values (x-client-data, x-browser-validation
    // are empty in config — they get captured dynamically from real Chrome)
    const filteredCrossSiteHeaders = {};
    for (const [k, v] of Object.entries(config.CROSS_SITE_HEADERS)) {
        if (v) filteredCrossSiteHeaders[k] = v;
    }

    const headers = {
        ...config.DEFAULT_HEADERS,
        ...filteredCrossSiteHeaders,
        // Override with dynamically captured browser headers (from captcha solving) if available
        ...(config.dynamicBrowserHeaders || {}),
        'content-type': 'text/plain;charset=UTF-8',
        'origin': config.LABS_BASE_URL,
        'referer': `${config.LABS_BASE_URL}/`,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site'
    };

    if (onLog && config.dynamicBrowserHeaders) {
        onLog(`Using dynamic browser headers: ${Object.keys(config.dynamicBrowserHeaders).join(', ')}`);
    }

    if (bearerToken) {
        headers['authorization'] = `Bearer ${bearerToken}`;
    }

    // NOTE: Do NOT retry on 500 here — reCAPTCHA tokens are single-use.
    // If we get a 500, the token is consumed. Retrying with the same token
    // causes a 403 "reCAPTCHA evaluation failed". The higher-level
    // solveAndGenerate() wrapper handles retries with fresh tokens.
    const response = await axiosWithRetry(
        () => axios.post(url, payload, { headers }),
        3,
        onLog,
        false  // never retryOn500 — let solveAndGenerate handle it
    );
    return response.data;
}

/**
 * Recursively search for a Bearer-like token (ya29.*) in any object
 */
function deepFindToken(obj, depth = 0) {
    if (depth > 5 || !obj) return null;
    if (typeof obj === 'string') {
        if (obj.startsWith('ya29.') && obj.length > 50) return obj;
    }
    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const result = deepFindToken(obj[key], depth + 1);
            if (result) return result;
        }
    }
    return null;
}

/**
 * Get Bearer token from session (calls NextAuth session endpoint)
 * Logs full response for debugging
 */
async function getBearerToken(onLog, cookies) {
    const url = `${config.LABS_BASE_URL}/fx/api/auth/session`;
    if (onLog) onLog(`[Auth] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            ...config.DEFAULT_HEADERS,
            'referer': `${config.LABS_BASE_URL}/fx/id/tools/flow`,
            'cookie': cookies || getLabsCookies()
        }
    });

    const data = response.data;
    if (onLog) onLog(`[Auth] Session response (full): ${safeJson(data)}`);
    if (onLog) onLog(`[Auth] Response type: ${typeof data}, keys: ${data ? Object.keys(data).join(', ') : 'null'}`);

    // Try various possible field paths
    const fieldMap = {
        'accessToken': data?.accessToken,
        'access_token': data?.access_token,
        'token': data?.token,
        'idToken': data?.idToken,
        'googleAccessToken': data?.googleAccessToken,
        'user.accessToken': data?.user?.accessToken,
        'user.token': data?.user?.token,
        'session.accessToken': data?.session?.accessToken,
    };

    for (const [name, val] of Object.entries(fieldMap)) {
        if (val && typeof val === 'string' && val.length > 20) {
            if (onLog) onLog(`[Auth] ✓ Found token at field '${name}' (${val.length} chars)`);
            return val;
        }
    }

    // Deep search: recursively look for anything starting with ya29.
    if (onLog) onLog('[Auth] Standard fields empty, trying deep search for ya29.* token...');
    const found = deepFindToken(data);
    if (found) {
        if (onLog) onLog(`[Auth] ✓ Found token via deep search (${found.length} chars)`);
        return found;
    }

    if (onLog) onLog('[Auth] ✗ No token found in any field. Full data dumped above.');
    throw new Error('Could not extract Bearer token from session. See full response above.');
}

/**
 * Full pipeline: run all steps to generate an image
 * Now with VERBOSE detailed logging
 */
async function generateImage(prompt, options = {}, onStatus) {
    const sessionId = generateSessionId();

    // Acquire account for this generation session
    const account = sessionManager.acquireAccount();
    if (!account) {
        return { success: false, error: 'No valid account available', logs: [{ time: new Date().toISOString(), message: 'ERROR: No valid account available' }] };
    }

    const projectId = options.projectId || account.projectId || config.PROJECT_ID;
    const acCookies = account.cookies;

    const statusLog = [];
    function log(msg) {
        const entry = { time: new Date().toISOString(), message: msg };
        statusLog.push(entry);
        if (onStatus) onStatus(entry);
    }

    try {
        log(`═══ GENERATION START ═══`);
        log(`🔄 Account: "${account.label}" (${account.email || 'no email'})`);
        log(`Prompt: "${prompt}"`);
        log(`Project ID: ${projectId}`);
        log(`Session ID: ${sessionId}`);
        log(`Aspect Ratio: ${options.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT'}`);
        log(`Model: ${options.model || 'GEM_PIX_2'}`);
        log(`Seed: ${options.seed || 'random'}`);
        log(`Cookie preview: ${trunc(acCookies, 60)}`);
        log('');

        // Step 1: Search project scenes
        log('── Step 1/6: Search Project Scenes ──');
        log(`GET ${config.LABS_BASE_URL}/fx/api/trpc/project.searchProjectScenes`);
        try {
            const s1result = await searchProjectScenes(projectId, acCookies);
            log(`Response: ${trunc(safeJson(s1result), 200)}`);
            log('Step 1/6: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 1/6: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 2: Submit batch log
        log('── Step 2/6: Submit Batch Log ──');
        log(`POST ${config.LABS_BASE_URL}/fx/api/trpc/general.submitBatchLog`);
        try {
            const s2result = await submitBatchLog(projectId, sessionId, acCookies);
            log(`Response: ${trunc(safeJson(s2result), 200)}`);
            log('Step 2/6: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 2/6: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 3: CORS preflight
        log('── Step 3/6: CORS Preflight ──');
        const preflightUrl = `${config.SANDBOX_API_URL}/projects/${projectId}/flowMedia:batchGenerateImages`;
        log(`OPTIONS ${preflightUrl}`);
        try {
            const preflightStatus = await preflightBatchGenerate(projectId);
            log(`Preflight response status: ${preflightStatus}`);
            log('Step 3/6: ✓ Done');
        } catch (err) {
            log(`Step 3/6: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 4: Get Bearer token
        log('── Step 4/6: Get Bearer Token ──');
        log(`GET ${config.LABS_BASE_URL}/fx/api/auth/session`);
        let bearerToken;
        try {
            bearerToken = await getBearerToken(log, acCookies);
            log(`Bearer Token (masked): ${maskSecret(bearerToken)}`);
            log(`Token length: ${bearerToken.length} chars`);
            log('Step 4/6: ✓ Bearer Token Acquired');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 500)}` : err.message;
            log(`Step 4/6: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 5-6: Solve reCAPTCHA + Generate Images (with auto-retry on reCAPTCHA rejection)
        log('── Step 5-6/6: Solve reCAPTCHA + Generate Images ──');
        log(`Site Key: ${config.RECAPTCHA_SITE_KEY}`);
        log(`POST ${preflightUrl}`);
        log(`Body → prompt: "${prompt}"`);
        log(`Body → seed: ${options.seed || 'random'}, model: ${options.model || 'GEM_PIX_2'}`);
        let result;
        try {
            const genResult = await solveAndGenerate({
                action: 'IMAGE_GENERATION',
                solveOptions: { projectId, accountId: account.id },
                generateFn: async (recaptchaToken) => {
                    return await batchGenerateImages(projectId, prompt, recaptchaToken, {
                        ...options,
                        sessionId,
                        bearerToken,
                        onLog: log
                    });
                },
                log,
                maxRetries: 2
            });
            result = genResult.result;
            log(`Response (full): ${safeJson(result)}`);

            // Extract key info
            if (result.media && result.media.length > 0) {
                for (let i = 0; i < result.media.length; i++) {
                    const m = result.media[i];
                    const img = m.image?.generatedImage;
                    if (img) {
                        log(`── Image ${i + 1} ──`);
                        log(`  fifeUrl: ${img.fifeUrl}`);
                        log(`  seed: ${img.seed}`);
                        log(`  prompt (translated): ${img.prompt}`);
                        log(`  model: ${img.modelNameType}`);
                        log(`  aspectRatio: ${img.aspectRatio}`);
                        log(`  mediaId: ${img.mediaGenerationId}`);
                        log(`  visibility: ${img.mediaVisibility}`);
                    }
                }
            }

            log('Step 5-6/6: ✓ Image Generated!');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${safeJson(err.response.data)}` : err.message;
            log(`Step 5-6/6: ERROR — ${errData}`);
            if (err.response && err.response.headers) {
                log(`Response headers: ${safeJson(Object.fromEntries(
                    Object.entries(err.response.headers).filter(([k]) => !k.startsWith('x-'))
                ))}`);
            }
            throw err;
        }

        log('');
        log('═══ GENERATION COMPLETE ═══');

        return {
            success: true,
            data: result,
            logs: statusLog
        };
    } catch (error) {
        log('');
        log(`═══ GENERATION FAILED ═══`);
        log(`Error type: ${error.constructor.name}`);
        log(`Error message: ${error.message}`);
        if (error.response) {
            log(`HTTP Status: ${error.response.status}`);
            log(`Response data: ${trunc(safeJson(error.response.data), 500)}`);
        }
        if (error.stack) {
            log(`Stack: ${error.stack.split('\n').slice(0, 3).join(' → ')}`);
        }
        return {
            success: false,
            error: error.message,
            logs: statusLog
        };
    } finally {
        sessionManager.releaseAccount(account.id);
    }
}

/**
 * Fetch user acknowledgement (for image upload TOS)
 */
async function fetchUserAcknowledgement(projectId, cookies) {
    const input = JSON.stringify({
        json: {
            acknowledgementVersion: 'FLOW_IMAGE_UPLOAD_TOS'
        }
    });

    const url = `${config.LABS_BASE_URL}/fx/api/trpc/general.fetchUserAcknowledgement?input=${encodeURIComponent(input)}`;

    const response = await axios.get(url, {
        headers: {
            ...config.DEFAULT_HEADERS,
            'content-type': 'application/json',
            'referer': `${config.LABS_BASE_URL}/fx/id/tools/flow/project/${projectId}`,
            'cookie': cookies || getLabsCookies()
        }
    });

    return response.data;
}

/**
 * Submit batch log for image upload event
 */
async function submitUploadBatchLog(projectId, sessionId, event, extraProps = [], cookies) {
    const url = `${config.LABS_BASE_URL}/fx/api/trpc/general.submitBatchLog`;

    const eventProperties = [
        { key: 'TOOL_NAME', stringValue: 'PINHOLE' },
        { key: 'G1_PAYGATE_TIER', stringValue: 'PAYGATE_TIER_ONE' },
        { key: 'PINHOLE_PROMPT_BOX_MODE', stringValue: 'IMAGE_GENERATION' },
        { key: 'USER_AGENT', stringValue: config.DEFAULT_HEADERS['user-agent'] },
        { key: 'IS_DESKTOP' },
        ...extraProps
    ];

    const payload = {
        json: {
            appEvents: [{
                event: event,
                eventMetadata: {
                    sessionId: sessionId
                },
                eventProperties: eventProperties,
                activeExperiments: [],
                eventTime: new Date().toISOString()
            }]
        }
    };

    const response = await axios.post(url, payload, {
        headers: {
            ...config.DEFAULT_HEADERS,
            'content-type': 'application/json',
            'origin': config.LABS_BASE_URL,
            'referer': `${config.LABS_BASE_URL}/fx/id/tools/flow/project/${projectId}`,
            'cookie': cookies || getLabsCookies()
        }
    });

    return response.data;
}

/**
 * CORS preflight for flow/uploadImage
 */
async function preflightUploadUserImage() {
    const url = `${config.SANDBOX_API_URL.replace('/v1', '')}/v1/flow/uploadImage`;

    try {
        const response = await axios({
            method: 'OPTIONS',
            url: url,
            headers: {
                ...config.DEFAULT_HEADERS,
                'access-control-request-headers': 'authorization',
                'access-control-request-method': 'POST',
                'origin': config.LABS_BASE_URL,
                'referer': `${config.LABS_BASE_URL}/`,
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'cross-site'
            }
        });
        return response.status;
    } catch (err) {
        return err.response ? err.response.status : 0;
    }
}

/**
 * Upload user image to get media name (ID)
 * @param {string} base64Image - Base64 encoded image (without data:image prefix)
 * @param {string} bearerToken - Bearer token
 * @param {function} onLog - logging function
 * @param {string} projectId - project ID for clientContext
 * @returns {object} { media: { name: "..." }, ... }
 */
async function uploadUserImage(base64Image, bearerToken, onLog, projectId) {
    const url = `${config.SANDBOX_API_URL.replace('/v1', '')}/v1/flow/uploadImage`;

    if (onLog) onLog(`[Upload] base64 prefix: "${base64Image.substring(0, 30)}..."`);
    if (onLog) onLog(`[Upload] base64 length: ${base64Image.length}`);

    const pid = projectId || config.PROJECT_ID;

    const payload = {
        clientContext: {
            projectId: pid,
            tool: 'PINHOLE'
        },
        imageBytes: base64Image
    };

    if (onLog) onLog(`[Upload] POST ${url}`);

    // NOTE: Do NOT include CROSS_SITE_HEADERS or dynamicBrowserHeaders here!
    // The upload only needs Bearer token auth. Sending x-client-data from a
    // previous browser session causes a mismatch when the subsequent captcha
    // is solved in a fresh Puppeteer instance → Google rejects the reCAPTCHA
    // token with 403 PERMISSION_DENIED.
    const headers = {
        ...config.DEFAULT_HEADERS,
        'content-type': 'text/plain;charset=UTF-8',
        'origin': config.LABS_BASE_URL,
        'referer': `${config.LABS_BASE_URL}/`,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'authorization': `Bearer ${bearerToken}`
    };

    const response = await axios.post(url, payload, {
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60000
    });

    if (onLog) onLog(`[Upload] Response status: ${response.status}`);
    if (onLog) onLog(`[Upload] Full response data: ${JSON.stringify(response.data)}`);
    return response.data;
}

/**
 * Full pipeline: run all steps to generate image WITH media reference
 * Adds image upload steps before the standard generation flow
 */
async function generateImageWithMedia(prompt, base64Image, imageWidth, imageHeight, options = {}, onStatus) {
    const sessionId = generateSessionId();

    // Acquire account for this generation session
    const account = sessionManager.acquireAccount();
    if (!account) {
        return { success: false, error: 'No valid account available', logs: [{ time: new Date().toISOString(), message: 'ERROR: No valid account available' }] };
    }

    const projectId = options.projectId || account.projectId || config.PROJECT_ID;
    const acCookies = account.cookies;
    const aspectRatio = options.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE';

    const statusLog = [];
    function log(msg) {
        const entry = { time: new Date().toISOString(), message: msg };
        statusLog.push(entry);
        if (onStatus) onStatus(entry);
    }

    try {
        // Clear stale dynamic browser headers to prevent x-client-data mismatch
        // between upload and generation requests
        config.dynamicBrowserHeaders = null;

        log(`═══ GENERATION WITH MEDIA START ═══`);
        log(`🔄 Account: "${account.label}" (${account.email || 'no email'})`);
        log(`Prompt: "${prompt}"`);
        log(`Project ID: ${projectId}`);
        log(`Session ID: ${sessionId}`);
        log(`Image size: ${imageWidth}x${imageHeight}`);
        log(`Aspect Ratio: ${aspectRatio}`);
        log(`Model: ${options.model || 'GEM_PIX_2'}`);
        log(`Seed: ${options.seed || 'random'}`);
        log(`Cookie preview: ${trunc(acCookies, 60)}`);
        log('');

        // Step 1: Search project scenes
        log('── Step 1/10: Search Project Scenes ──');
        try {
            const s1result = await searchProjectScenes(projectId, acCookies);
            log(`Response: ${trunc(safeJson(s1result), 200)}`);
            log('Step 1/10: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 1/10: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 2: Fetch user acknowledgement (upload TOS)
        log('── Step 2/10: Fetch User Acknowledgement (Upload TOS) ──');
        try {
            const ackResult = await fetchUserAcknowledgement(projectId, acCookies);
            log(`Response: ${trunc(safeJson(ackResult), 200)}`);
            log('Step 2/10: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 2/10: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 3: Submit batch log - PINHOLE_UPLOAD_IMAGE
        log('── Step 3/10: Submit Batch Log (PINHOLE_UPLOAD_IMAGE) ──');
        try {
            const s3result = await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_UPLOAD_IMAGE', [], acCookies);
            log(`Response: ${trunc(safeJson(s3result), 200)}`);
            log('Step 3/10: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 3/10: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 4: Submit batch log - PINHOLE_UPLOAD_IMAGE_TO_CROP
        log('── Step 4/10: Submit Batch Log (PINHOLE_UPLOAD_IMAGE_TO_CROP) ──');
        try {
            const cropProps = [
                { key: 'PINHOLE_UPLOAD_IMAGE_TO_CROP_WIDTH', doubleValue: imageWidth },
                { key: 'PINHOLE_UPLOAD_IMAGE_TO_CROP_HEIGHT', doubleValue: imageHeight }
            ];
            const s4result = await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_UPLOAD_IMAGE_TO_CROP', cropProps, acCookies);
            log(`Response: ${trunc(safeJson(s4result), 200)}`);
            log('Step 4/10: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 4/10: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 5: Submit batch log - PINHOLE_RESIZE_IMAGE
        log('── Step 5/10: Submit Batch Log (PINHOLE_RESIZE_IMAGE) ──');
        try {
            const resizeProps = [
                { key: 'PINHOLE_IMAGE_ASPECT_RATIO', stringValue: aspectRatio }
            ];
            const s5result = await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_RESIZE_IMAGE', resizeProps, acCookies);
            log(`Response: ${trunc(safeJson(s5result), 200)}`);
            log('Step 5/10: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 5/10: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 6: Submit batch log - PINHOLE_GENERATE_IMAGE (required before generation!)
        log('── Step 6/11: Submit Batch Log (PINHOLE_GENERATE_IMAGE) ──');
        try {
            const s6result = await submitBatchLog(projectId, sessionId, acCookies);
            log(`Response: ${trunc(safeJson(s6result), 200)}`);
            log('Step 6/11: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 6/11: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 7: Get Bearer token
        log('── Step 7/11: Get Bearer Token ──');
        let bearerToken;
        try {
            bearerToken = await getBearerToken(log, acCookies);
            log(`Bearer Token (masked): ${maskSecret(bearerToken)}`);
            log(`Token length: ${bearerToken.length} chars`);
            log('Step 7/11: ✓ Bearer Token Acquired');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 500)}` : err.message;
            log(`Step 7/11: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 7-10: Upload + Solve reCAPTCHA + Generate — ALL within same Puppeteer browser
        // This ensures upload and generation have consistent browser signals (x-client-data,
        // TLS fingerprint), preventing Google's UNUSUAL_ACTIVITY detection.
        log('── Step 8-11/11: Upload + reCAPTCHA + Generate (In-Browser) ──');

        // Detect mime type for upload
        let mimeType = 'image/jpeg';
        try {
            const header = base64Image.substring(0, 16);
            const bytes = Buffer.from(header, 'base64');
            if (bytes[0] === 0x89 && bytes[1] === 0x50) mimeType = 'image/png';
            else if (bytes[0] === 0x52 && bytes[1] === 0x49) mimeType = 'image/webp';
        } catch (e) { }

        let uploadedMediaId = null;
        let result;
        try {
            const genResult = await solveAndGenerate({
                action: 'IMAGE_GENERATION',
                solveOptions: {
                    projectId,
                    accountId: account.id,
                    // Upload image from within browser BEFORE captcha solving
                    beforeSolve: async (page) => {
                        const uploadUrl = `${config.SANDBOX_API_URL.replace('/v1', '')}/v1/flow/uploadImage`;
                        log(`[InBrowser] Uploading image (${base64Image.length} chars)...`);
                        const uploadPayload = { clientContext: { projectId, tool: 'PINHOLE' }, imageBytes: base64Image };
                        const uploadResult = await makeInBrowserApiCall(page, uploadUrl, uploadPayload, bearerToken, log);
                        uploadedMediaId = uploadResult?.media?.name;
                        if (!uploadedMediaId) throw new Error('No media name from upload');
                        log(`[InBrowser] ✓ Upload done — media name: ${uploadedMediaId}`);
                        log(`[InBrowser] Upload response: ${JSON.stringify(uploadResult).substring(0, 200)}`);
                    }
                },
                browserGenerateFn: async (page, recaptchaToken) => {
                    const url = `${config.SANDBOX_API_URL}/projects/${projectId}/flowMedia:batchGenerateImages`;
                    const imageInputs = [{ name: uploadedMediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' }];
                    const clientContext = {
                        recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                        sessionId, projectId, tool: 'PINHOLE', userPaygateTier: 'PAYGATE_TIER_ONE'
                    };
                    const requestPayload = {
                        clientContext,
                        seed: options.seed || Math.floor(Math.random() * 999999),
                        imageModelName: options.model || 'GEM_PIX_2',
                        imageAspectRatio: aspectRatio,
                        prompt,
                        imageInputs
                    };
                    log(`[InBrowser] imageInputs: ${JSON.stringify(imageInputs)}`);
                    return await makeInBrowserApiCall(page, url, { clientContext, requests: [requestPayload] }, bearerToken, log);
                },
                log,
                maxRetries: 3,
                forcePuppeteerAll: true
            });
            result = genResult.result;
            log(`Response (full): ${safeJson(result)}`);

            // Extract key info
            if (result.media && result.media.length > 0) {
                for (let i = 0; i < result.media.length; i++) {
                    const m = result.media[i];
                    const img = m.image?.generatedImage;
                    if (img) {
                        log(`── Image ${i + 1} ──`);
                        log(`  fifeUrl: ${img.fifeUrl}`);
                        log(`  seed: ${img.seed}`);
                        log(`  prompt (translated): ${img.prompt}`);
                        log(`  model: ${img.modelNameType}`);
                        log(`  aspectRatio: ${img.aspectRatio}`);
                        log(`  mediaId: ${img.mediaGenerationId}`);
                        log(`  visibility: ${img.mediaVisibility}`);
                    }
                }
            }

            log('Step 10-11/11: ✓ Image Generated!');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${safeJson(err.response.data)}` : err.message;
            log(`Step 10-11/11: ERROR — ${errData}`);
            if (err.response && err.response.headers) {
                log(`Response headers: ${safeJson(Object.fromEntries(
                    Object.entries(err.response.headers).filter(([k]) => !k.startsWith('x-'))
                ))}`);
            }
            throw err;
        }

        log('');
        log('═══ GENERATION WITH MEDIA COMPLETE ═══');

        return {
            success: true,
            data: result,
            logs: statusLog
        };
    } catch (error) {
        log('');
        log(`═══ GENERATION WITH MEDIA FAILED ═══`);
        log(`Error type: ${error.constructor.name}`);
        log(`Error message: ${error.message}`);
        if (error.response) {
            log(`HTTP Status: ${error.response.status}`);
            log(`Response data: ${trunc(safeJson(error.response.data), 500)}`);
        }
        if (error.stack) {
            log(`Stack: ${error.stack.split('\n').slice(0, 3).join(' → ')}`);
        }
        return {
            success: false,
            error: error.message,
            logs: statusLog
        };
    } finally {
        sessionManager.releaseAccount(account.id);
    }
}

// ============================================================
// MULTI-IMAGE GENERATION
// ============================================================

/**
 * Full pipeline: generate image with MULTIPLE media references
 * Uploads all images, then passes them all as imageInputs
 */
async function generateImageWithMultiMedia(prompt, base64Images, imageWidth, imageHeight, options = {}, onStatus) {
    const sessionId = generateSessionId();

    const account = sessionManager.acquireAccount();
    if (!account) {
        return { success: false, error: 'No valid account available', logs: [{ time: new Date().toISOString(), message: 'ERROR: No valid account available' }] };
    }

    const projectId = options.projectId || account.projectId || config.PROJECT_ID;
    const acCookies = account.cookies;
    const aspectRatio = options.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE';

    const statusLog = [];
    function log(msg) {
        const entry = { time: new Date().toISOString(), message: msg };
        statusLog.push(entry);
        if (onStatus) onStatus(entry);
    }

    try {
        // Clear stale dynamic browser headers to prevent x-client-data mismatch
        config.dynamicBrowserHeaders = null;

        log(`═══ GENERATION WITH MULTI-MEDIA START (${base64Images.length} images) ═══`);
        log(`🔄 Account: "${account.label}" (${account.email || 'no email'})`);
        log(`Prompt: "${prompt.substring(0, 100)}"`);
        log(`Project ID: ${projectId}`);
        log(`Images to upload: ${base64Images.length}`);
        log(`Aspect Ratio: ${aspectRatio}`);
        log('');

        // Step 1: Search project scenes
        log('── Step 1: Search Project Scenes ──');
        try {
            await searchProjectScenes(projectId, acCookies);
            log('Step 1: ✓ Done');
        } catch (err) {
            log(`Step 1: ERROR — ${err.message}`);
            throw err;
        }
        log('');

        // Step 2: Fetch user acknowledgement
        log('── Step 2: Fetch User Acknowledgement ──');
        try {
            await fetchUserAcknowledgement(projectId, acCookies);
            log('Step 2: ✓ Done');
        } catch (err) {
            log(`Step 2: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 3: Get Bearer token
        log('── Step 3: Get Bearer Token ──');
        let bearerToken;
        try {
            bearerToken = await getBearerToken(log, acCookies);
            log(`Token length: ${bearerToken.length} chars`);
            log('Step 3: ✓ Bearer Token Acquired');
        } catch (err) {
            log(`Step 3: ERROR — ${err.message}`);
            throw err;
        }
        log('');

        // Step 4-7: Upload ALL + Solve reCAPTCHA + Generate — ALL within same Puppeteer browser
        log('── Step 4-7: Upload + reCAPTCHA + Generate (In-Browser) ──');
        log(`Images to upload: ${base64Images.length}`);

        const imageInputs = [];
        let result;
        try {
            const genResult = await solveAndGenerate({
                action: 'IMAGE_GENERATION',
                solveOptions: {
                    projectId,
                    accountId: account.id,
                    beforeSolve: async (page) => {
                        // Upload ALL images from within browser
                        for (let i = 0; i < base64Images.length; i++) {
                            const imgData = base64Images[i];
                            let mimeType = 'image/jpeg';
                            try {
                                const header = imgData.substring(0, 16);
                                const bytes = Buffer.from(header, 'base64');
                                if (bytes[0] === 0x89 && bytes[1] === 0x50) mimeType = 'image/png';
                                else if (bytes[0] === 0x52 && bytes[1] === 0x49) mimeType = 'image/webp';
                            } catch (e) { }

                            log(`[InBrowser] Uploading image ${i + 1}/${base64Images.length} (${imgData.length} chars, ${mimeType})...`);
                            const uploadUrl = `${config.SANDBOX_API_URL.replace('/v1', '')}/v1/flow/uploadImage`;
                            const uploadPayload = { clientContext: { projectId, tool: 'PINHOLE' }, imageBytes: imgData };
                            const uploadResult = await makeInBrowserApiCall(page, uploadUrl, uploadPayload, bearerToken, log);
                            const mediaId = uploadResult?.media?.name;
                            if (!mediaId) throw new Error(`No media name for image ${i + 1}`);
                            log(`[InBrowser] ✓ Image ${i + 1} uploaded: ${mediaId}`);
                            imageInputs.push({ name: mediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' });
                        }
                        log(`[InBrowser] ✓ All ${imageInputs.length} images uploaded`);
                    }
                },
                browserGenerateFn: async (page, recaptchaToken) => {
                    const url = `${config.SANDBOX_API_URL}/projects/${projectId}/flowMedia:batchGenerateImages`;
                    const clientContext = {
                        recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                        sessionId, projectId, tool: 'PINHOLE', userPaygateTier: 'PAYGATE_TIER_ONE'
                    };
                    const requestPayload = {
                        clientContext,
                        seed: options.seed || Math.floor(Math.random() * 999999),
                        imageModelName: options.model || 'GEM_PIX_2',
                        imageAspectRatio: aspectRatio,
                        prompt,
                        imageInputs
                    };
                    log(`[InBrowser] imageInputs: ${JSON.stringify(imageInputs)}`);
                    return await makeInBrowserApiCall(page, url, { clientContext, requests: [requestPayload] }, bearerToken, log);
                },
                log,
                maxRetries: 3,
                forcePuppeteerAll: true
            });
            result = genResult.result;
            log(`Response: ${trunc(safeJson(result), 500)}`);

            if (result.media && result.media.length > 0) {
                for (let i = 0; i < result.media.length; i++) {
                    const img = result.media[i]?.image?.generatedImage;
                    if (img) {
                        log(`── Image ${i + 1}: ${img.fifeUrl}`);
                    }
                }
            }
            log('Step 6-7: ✓ Image Generated!');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${safeJson(err.response.data)}` : err.message;
            log(`Step 6-7: ERROR — ${errData}`);
            throw err;
        }

        log('');
        log('═══ GENERATION WITH MULTI-MEDIA COMPLETE ═══');

        return {
            success: true,
            data: result,
            logs: statusLog
        };
    } catch (error) {
        log('');
        log(`═══ GENERATION WITH MULTI-MEDIA FAILED ═══`);
        log(`Error: ${error.message}`);
        return {
            success: false,
            error: error.message,
            logs: statusLog
        };
    } finally {
        sessionManager.releaseAccount(account.id);
    }
}

// ============================================================
// VIDEO MODEL FUNCTIONS
// ============================================================

/**
 * CORS preflight for video endpoints
 */
async function preflightVideo(endpoint) {
    const url = `${config.SANDBOX_API_URL}/video:${endpoint}`;
    try {
        const response = await axios({
            method: 'OPTIONS',
            url: url,
            headers: {
                ...config.DEFAULT_HEADERS,
                'access-control-request-headers': 'authorization',
                'access-control-request-method': 'POST',
                'origin': config.LABS_BASE_URL,
                'referer': `${config.LABS_BASE_URL}/`,
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'cross-site'
            }
        });
        return response.status;
    } catch (err) {
        return err.response ? err.response.status : 0;
    }
}

/**
 * Text to Video — batchAsyncGenerateVideoText
 */
async function batchAsyncGenerateVideoText(projectId, prompt, recaptchaToken, options = {}) {
    const {
        seed = Math.floor(Math.random() * 999999),
        aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT',
        videoModelKey = 'veo_3_1_t2v_fast_portrait',
        sessionId = generateSessionId(),
        bearerToken = null
    } = options;

    const sceneId = uuidv4();
    const url = `${config.SANDBOX_API_URL}/video:batchAsyncGenerateVideoText`;

    const payload = {
        clientContext: {
            recaptchaContext: {
                token: recaptchaToken,
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
            },
            sessionId: sessionId,
            projectId: projectId,
            tool: 'PINHOLE',
            userPaygateTier: 'PAYGATE_TIER_ONE'
        },
        requests: [{
            aspectRatio: aspectRatio,
            seed: seed,
            textInput: {
                prompt: prompt
            },
            videoModelKey: videoModelKey,
            metadata: {
                sceneId: sceneId
            }
        }]
    };

    const headers = {
        ...config.DEFAULT_HEADERS,
        ...config.CROSS_SITE_HEADERS,
        'content-type': 'text/plain;charset=UTF-8',
        'origin': config.LABS_BASE_URL,
        'referer': `${config.LABS_BASE_URL}/`,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site'
    };

    if (bearerToken) {
        headers['authorization'] = `Bearer ${bearerToken}`;
    }

    const response = await axios.post(url, payload, { headers });
    return response.data;
}

/**
 * Text + Media to Video — batchAsyncGenerateVideoReferenceImages
 */
async function batchAsyncGenerateVideoRefImages(projectId, prompt, recaptchaToken, options = {}) {
    const {
        seed = Math.floor(Math.random() * 999999),
        aspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT',
        videoModelKey = 'veo_3_1_r2v_fast_portrait',
        sessionId = generateSessionId(),
        bearerToken = null,
        mediaId = null
    } = options;

    const sceneId = uuidv4();
    const url = `${config.SANDBOX_API_URL}/video:batchAsyncGenerateVideoReferenceImages`;

    const payload = {
        clientContext: {
            recaptchaContext: {
                token: recaptchaToken,
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
            },
            sessionId: sessionId,
            projectId: projectId,
            tool: 'PINHOLE',
            userPaygateTier: 'PAYGATE_TIER_ONE'
        },
        requests: [{
            aspectRatio: aspectRatio,
            metadata: {
                sceneId: sceneId
            },
            referenceImages: [{
                imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
                mediaId: mediaId
            }],
            seed: seed,
            textInput: {
                prompt: prompt
            },
            videoModelKey: videoModelKey
        }]
    };

    const headers = {
        ...config.DEFAULT_HEADERS,
        ...config.CROSS_SITE_HEADERS,
        'content-type': 'text/plain;charset=UTF-8',
        'origin': config.LABS_BASE_URL,
        'referer': `${config.LABS_BASE_URL}/`,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site'
    };

    if (bearerToken) {
        headers['authorization'] = `Bearer ${bearerToken}`;
    }

    const response = await axios.post(url, payload, { headers });
    return response.data;
}

/**
 * Check async video generation status
 * POST /v1/video:batchCheckAsyncVideoGenerationStatus
 * Payload: { operations: [{ operation: { name }, sceneId, status }] }
 * Each poll sends the LAST known status; API returns updated status.
 * Status flow: PENDING → ACTIVE → SUCCESSFUL (or FAILED)
 */
async function batchCheckAsyncVideoGenerationStatus(operations, bearerToken) {
    const url = `${config.SANDBOX_API_URL}/video:batchCheckAsyncVideoGenerationStatus`;

    const payload = { operations };

    const headers = {
        ...config.DEFAULT_HEADERS,
        ...config.CROSS_SITE_HEADERS,
        'content-type': 'text/plain;charset=UTF-8',
        'origin': config.LABS_BASE_URL,
        'referer': `${config.LABS_BASE_URL}/`,
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'authorization': `Bearer ${bearerToken}`
    };

    const response = await axios.post(url, payload, { headers });
    return response.data;
}

/**
 * Poll video operation until SUCCESSFUL or FAILED
 * Uses batchCheckAsyncVideoGenerationStatus with the operations array
 * from the initial generation response. Updates status each poll.
 */
async function pollVideoOperation(projectId, operationName, bearerToken, onLog, maxAttempts = 120, intervalMs = 5000, initialOperations = null) {
    if (onLog) onLog(`[Poll] Polling operation: ${operationName}`);
    if (onLog) onLog(`[Poll] Max attempts: ${maxAttempts}, interval: ${intervalMs}ms`);
    if (onLog) onLog(`[Poll] Using video:batchCheckAsyncVideoGenerationStatus`);

    // Build the operations array for polling
    // Use initial operations from generation response, or build minimal one
    let currentOperations = initialOperations || [{
        operation: { name: operationName },
        sceneId: '',
        status: 'MEDIA_GENERATION_STATUS_PENDING'
    }];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));

        if (onLog) onLog(`[Poll] Attempt ${attempt}/${maxAttempts}...`);

        try {
            const result = await batchCheckAsyncVideoGenerationStatus(currentOperations, bearerToken);
            const operations = result?.operations || [];

            if (operations.length === 0) {
                if (onLog) onLog(`[Poll] Empty operations response`);
                continue;
            }

            // Find our operation
            const op = operations.find(o => o.operation?.name === operationName) || operations[0];
            const status = op.status;

            if (onLog) onLog(`[Poll] Operation "${op.operation?.name}" status: ${status}`);

            if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                const vid = op.operation?.metadata?.video;
                if (onLog) onLog(`[Poll] ✓ Video generation complete!`);
                return {
                    status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
                    video: vid,
                    media: op,
                    fullResult: result
                };
            }

            if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
                throw new Error('Video generation failed (MEDIA_GENERATION_STATUS_FAILED)');
            }

            // Update currentOperations with the latest status for next poll
            currentOperations = operations.map(o => ({
                operation: { name: o.operation?.name },
                sceneId: o.sceneId || '',
                status: o.status
            }));

            if (attempt % 6 === 0) {
                if (onLog) onLog(`[Poll] Still waiting... (${Math.round(attempt * intervalMs / 1000)}s elapsed)`);
            }

        } catch (err) {
            if (err.message.includes('FAILED')) throw err;
            if (onLog) onLog(`[Poll] Check error: ${err.message} (retrying...)`);
        }
    }

    throw new Error(`Video generation timed out after ${maxAttempts * intervalMs / 1000}s`);
}

/**
 * Full pipeline: Text to Video
 * Steps: 1.SearchScenes → 2.BatchLog → 3.Preflight → 4.BearerToken → 5.reCAPTCHA → 6.GenerateVideo → 7.Poll
 */
async function generateVideo(prompt, options = {}, onStatus) {
    const sessionId = generateSessionId();

    // Acquire account for this generation session
    const account = sessionManager.acquireAccount();
    if (!account) {
        return { success: false, error: 'No valid account available', videoType: 'text', logs: [{ time: new Date().toISOString(), message: 'ERROR: No valid account available' }] };
    }

    const projectId = options.projectId || account.projectId || config.PROJECT_ID;
    const acCookies = account.cookies;

    const statusLog = [];
    function log(msg) {
        const entry = { time: new Date().toISOString(), message: msg };
        statusLog.push(entry);
        if (onStatus) onStatus(entry);
    }

    try {
        log(`═══ VIDEO GENERATION START ═══`);
        log(`🔄 Account: "${account.label}" (${account.email || 'no email'})`);
        log(`Prompt: "${prompt}"`);
        log(`Project ID: ${projectId}`);
        log(`Session ID: ${sessionId}`);
        log(`Aspect Ratio: ${options.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT'}`);
        log(`Video Model: ${options.videoModelKey || 'veo_3_1_t2v_fast_portrait'}`);
        log(`Seed: ${options.seed || 'random'}`);
        log('');

        // Step 1: Search project scenes
        log('── Step 1/7: Search Project Scenes ──');
        try {
            const s1result = await searchProjectScenes(projectId, acCookies);
            log(`Response: ${trunc(safeJson(s1result), 200)}`);
            log('Step 1/7: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 1/7: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 2: Submit batch log
        log('── Step 2/7: Submit Batch Log ──');
        try {
            const s2result = await submitBatchLog(projectId, sessionId, acCookies);
            log(`Response: ${trunc(safeJson(s2result), 200)}`);
            log('Step 2/7: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 2/7: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 3: CORS preflight
        log('── Step 3/7: CORS Preflight (video) ──');
        try {
            const preflightStatus = await preflightVideo('batchAsyncGenerateVideoText');
            log(`Preflight response status: ${preflightStatus}`);
            log('Step 3/7: ✓ Done');
        } catch (err) {
            log(`Step 3/7: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 4: Get Bearer token
        log('── Step 4/7: Get Bearer Token ──');
        let bearerToken;
        try {
            bearerToken = await getBearerToken(log, acCookies);
            log(`Token length: ${bearerToken.length} chars`);
            log('Step 4/7: ✓ Bearer Token Acquired');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 500)}` : err.message;
            log(`Step 4/7: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 5-6: Solve reCAPTCHA + Generate Video (with auto-retry on reCAPTCHA rejection)
        log('── Step 5-6/7: Solve reCAPTCHA + Generate Video (Text) ──');
        const genUrl = `${config.SANDBOX_API_URL}/video:batchAsyncGenerateVideoText`;
        log(`POST ${genUrl}`);
        log(`Body → prompt: "${prompt}"`);
        log(`Body → videoModelKey: ${options.videoModelKey || 'veo_3_1_t2v_fast_portrait'}`);
        log(`Body → aspectRatio: ${options.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT'}`);

        let genResult;
        let operationName;
        try {
            const solveResult = await solveAndGenerate({
                action: 'VIDEO_GENERATION',
                solveOptions: { projectId, accountId: account.id },
                generateFn: async (recaptchaToken) => {
                    return await batchAsyncGenerateVideoText(projectId, prompt, recaptchaToken, {
                        ...options,
                        sessionId,
                        bearerToken
                    });
                },
                log,
                maxRetries: 2
            });
            genResult = solveResult.result;
            log(`Response: ${trunc(safeJson(genResult), 400)}`);

            // Extract operation name for polling
            operationName = genResult?.operations?.[0]?.operation?.name;
            const status = genResult?.operations?.[0]?.status;
            const credits = genResult?.remainingCredits;

            if (operationName) {
                log(`Operation: ${operationName}`);
                log(`Initial status: ${status}`);
                if (credits !== undefined) log(`Remaining credits: ${credits}`);
            }

            // Check if already complete (unlikely but possible)
            if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                const vid = genResult.operations[0].operation?.metadata?.video;
                if (vid?.fifeUrl) {
                    log('Step 5-6/7: ✓ Video Generated Immediately!');
                    log('');
                    log('═══ VIDEO GENERATION COMPLETE ═══');
                    return { success: true, data: genResult, videoType: 'text', logs: statusLog };
                }
            }

            log('Step 5-6/7: ✓ Generation Submitted (PENDING)');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${safeJson(err.response.data)}` : err.message;
            log(`Step 5-6/7: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 7: Poll for completion
        log('── Step 7/7: Poll Video Operation ──');
        log(`Polling operation: ${operationName}`);
        log('Video generation can take 1-5 minutes...');
        let finalData = genResult;
        try {
            // Extract initial operations array from generation response for polling
            const initialOps = (genResult?.operations || []).map(o => ({
                operation: { name: o.operation?.name },
                sceneId: o.sceneId || '',
                status: o.status || 'MEDIA_GENERATION_STATUS_PENDING'
            }));

            const pollResult = await pollVideoOperation(projectId, operationName, bearerToken, log, 120, 5000, initialOps);
            log(`Poll result: ${trunc(safeJson(pollResult), 400)}`);

            if (pollResult.video?.fifeUrl) {
                log(`── Video Result ──`);
                log(`  fifeUrl: ${pollResult.video.fifeUrl}`);
                log(`  seed: ${pollResult.video.seed}`);
                log(`  model: ${pollResult.video.model}`);
                log(`  aspectRatio: ${pollResult.video.aspectRatio}`);
                if (pollResult.video.servingBaseUri) {
                    log(`  thumbnail: ${pollResult.video.servingBaseUri}`);
                }
            }

            // Merge poll result into data for downloader
            if (pollResult.fullResult) {
                finalData = pollResult.fullResult;
            } else if (pollResult.video) {
                finalData = {
                    ...genResult,
                    operations: [{
                        operation: {
                            name: operationName,
                            metadata: { video: pollResult.video }
                        },
                        status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
                    }]
                };
            }

            log('Step 7/7: ✓ Video Ready!');
        } catch (err) {
            log(`Step 7/7: ERROR — ${err.message}`);
            throw err;
        }

        log('');
        log('═══ VIDEO GENERATION COMPLETE ═══');

        return {
            success: true,
            data: finalData,
            videoType: 'text',
            logs: statusLog
        };
    } catch (error) {
        log('');
        log(`═══ VIDEO GENERATION FAILED ═══`);
        log(`Error type: ${error.constructor.name}`);
        log(`Error message: ${error.message}`);
        if (error.response) {
            log(`HTTP Status: ${error.response.status}`);
            log(`Response data: ${trunc(safeJson(error.response.data), 500)}`);
        }
        if (error.stack) {
            log(`Stack: ${error.stack.split('\n').slice(0, 3).join(' → ')}`);
        }
        return {
            success: false,
            error: error.message,
            videoType: 'text',
            logs: statusLog
        };
    } finally {
        sessionManager.releaseAccount(account.id);
    }
}

/**
 * Full pipeline: Text + Media to Video
 * Steps: 1.SearchScenes → 2.Acknowledgement → 3-5.BatchLogs → 6.BearerToken → 7.Preflight →
 *         8.UploadImage → 9.reCAPTCHA → 10.GenerateVideo → 11.Poll
 */
async function generateVideoWithMedia(prompt, base64Image, imageWidth, imageHeight, options = {}, onStatus) {
    const sessionId = generateSessionId();

    // Acquire account for this generation session
    const account = sessionManager.acquireAccount();
    if (!account) {
        return { success: false, error: 'No valid account available', videoType: 'media', logs: [{ time: new Date().toISOString(), message: 'ERROR: No valid account available' }] };
    }

    const projectId = options.projectId || account.projectId || config.PROJECT_ID;
    const acCookies = account.cookies;
    const aspectRatio = options.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';

    const statusLog = [];
    function log(msg) {
        const entry = { time: new Date().toISOString(), message: msg };
        statusLog.push(entry);
        if (onStatus) onStatus(entry);
    }

    try {
        // Clear stale dynamic browser headers to prevent x-client-data mismatch
        config.dynamicBrowserHeaders = null;

        log(`═══ VIDEO WITH MEDIA GENERATION START ═══`);
        log(`🔄 Account: "${account.label}" (${account.email || 'no email'})`);
        log(`Prompt: "${prompt}"`);
        log(`Project ID: ${projectId}`);
        log(`Session ID: ${sessionId}`);
        log(`Image size: ${imageWidth}x${imageHeight}`);
        log(`Aspect Ratio: ${aspectRatio}`);
        log(`Video Model: ${options.videoModelKey || 'veo_3_1_r2v_fast_portrait'}`);
        log(`Seed: ${options.seed || 'random'}`);
        log('');

        // Step 1: Search project scenes
        log('── Step 1/11: Search Project Scenes ──');
        try {
            const s1result = await searchProjectScenes(projectId, acCookies);
            log(`Response: ${trunc(safeJson(s1result), 200)}`);
            log('Step 1/11: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 1/11: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 2: Fetch user acknowledgement
        log('── Step 2/11: Fetch User Acknowledgement ──');
        try {
            const ackResult = await fetchUserAcknowledgement(projectId, acCookies);
            log(`Response: ${trunc(safeJson(ackResult), 200)}`);
            log('Step 2/11: ✓ Done');
        } catch (err) {
            log(`Step 2/11: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 3: Submit batch log - PINHOLE_UPLOAD_IMAGE
        log('── Step 3/11: Submit Batch Log (PINHOLE_UPLOAD_IMAGE) ──');
        try {
            await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_UPLOAD_IMAGE', [], acCookies);
            log('Step 3/11: ✓ Done');
        } catch (err) {
            log(`Step 3/11: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 4: Submit batch log - PINHOLE_UPLOAD_IMAGE_TO_CROP
        log('── Step 4/11: Submit Batch Log (PINHOLE_UPLOAD_IMAGE_TO_CROP) ──');
        try {
            const cropProps = [
                { key: 'PINHOLE_UPLOAD_IMAGE_TO_CROP_WIDTH', doubleValue: imageWidth },
                { key: 'PINHOLE_UPLOAD_IMAGE_TO_CROP_HEIGHT', doubleValue: imageHeight }
            ];
            await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_UPLOAD_IMAGE_TO_CROP', cropProps, acCookies);
            log('Step 4/11: ✓ Done');
        } catch (err) {
            log(`Step 4/11: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 5: Submit batch log - PINHOLE_RESIZE_IMAGE
        log('── Step 5/11: Submit Batch Log (PINHOLE_RESIZE_IMAGE) ──');
        try {
            const resizeProps = [
                { key: 'PINHOLE_IMAGE_ASPECT_RATIO', stringValue: aspectRatio }
            ];
            await submitUploadBatchLog(projectId, sessionId, 'PINHOLE_RESIZE_IMAGE', resizeProps, acCookies);
            log('Step 5/11: ✓ Done');
        } catch (err) {
            log(`Step 5/11: WARNING — ${err.message} (non-critical)`);
        }
        log('');

        // Step 6: Submit batch log - PINHOLE_GENERATE_IMAGE (required before generation!)
        log('── Step 6/12: Submit Batch Log (PINHOLE_GENERATE_IMAGE) ──');
        try {
            const s6result = await submitBatchLog(projectId, sessionId, acCookies);
            log(`Response: ${trunc(safeJson(s6result), 200)}`);
            log('Step 6/12: ✓ Done');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 200)}` : err.message;
            log(`Step 6/12: WARNING — ${errData} (non-critical)`);
        }
        log('');

        // Step 7: Get Bearer token
        log('── Step 7/12: Get Bearer Token ──');
        let bearerToken;
        try {
            bearerToken = await getBearerToken(log, acCookies);
            log(`Token length: ${bearerToken.length} chars`);
            log('Step 6/11: ✓ Bearer Token Acquired');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${trunc(safeJson(err.response.data), 500)}` : err.message;
            log(`Step 6/11: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 7-10: Upload + Solve reCAPTCHA + Generate — ALL within same Puppeteer browser
        log('── Step 7-10/11: Upload + reCAPTCHA + Generate Video (In-Browser) ──');

        // Detect mime type for upload
        let mimeType = 'image/jpeg';
        try {
            const header = base64Image.substring(0, 16);
            const bytes = Buffer.from(header, 'base64');
            if (bytes[0] === 0x89 && bytes[1] === 0x50) mimeType = 'image/png';
            else if (bytes[0] === 0x52 && bytes[1] === 0x49) mimeType = 'image/webp';
        } catch (e) { }

        let uploadedMediaId = null;
        let genResult;
        let operationName;
        try {
            const solveResult = await solveAndGenerate({
                action: 'VIDEO_GENERATION',
                solveOptions: {
                    projectId,
                    accountId: account.id,
                    beforeSolve: async (page) => {
                        const uploadUrl = `${config.SANDBOX_API_URL.replace('/v1', '')}/v1/flow/uploadImage`;
                        log(`[InBrowser] Uploading image (${base64Image.length} chars)...`);
                        const uploadPayload = { clientContext: { projectId, tool: 'PINHOLE' }, imageBytes: base64Image };
                        const uploadResult = await makeInBrowserApiCall(page, uploadUrl, uploadPayload, bearerToken, log);
                        uploadedMediaId = uploadResult?.media?.name;
                        if (!uploadedMediaId) throw new Error('No media name from upload');
                        log(`[InBrowser] ✓ Upload done — media name: ${uploadedMediaId}`);
                    }
                },
                browserGenerateFn: async (page, recaptchaToken) => {
                    const url = `${config.SANDBOX_API_URL}/video:batchAsyncGenerateVideoReferenceImages`;
                    const sceneId = uuidv4();
                    const clientContext = {
                        recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                        sessionId, projectId, tool: 'PINHOLE', userPaygateTier: 'PAYGATE_TIER_ONE'
                    };
                    const payload = {
                        clientContext,
                        requests: [{
                            aspectRatio: aspectRatio,
                            metadata: { sceneId },
                            referenceImages: [{ imageUsageType: 'IMAGE_USAGE_TYPE_ASSET', mediaId: uploadedMediaId }],
                            seed: options.seed || Math.floor(Math.random() * 999999),
                            textInput: { prompt },
                            videoModelKey: options.videoModelKey || 'veo_3_1_r2v_fast_portrait'
                        }]
                    };
                    log(`[InBrowser] mediaId: ${trunc(uploadedMediaId, 60)}`);
                    return await makeInBrowserApiCall(page, url, payload, bearerToken, log);
                },
                log,
                maxRetries: 3,
                forcePuppeteerAll: true
            });
            genResult = solveResult.result;
            log(`Response: ${trunc(safeJson(genResult), 400)}`);

            operationName = genResult?.operations?.[0]?.operation?.name;
            const status = genResult?.operations?.[0]?.status;
            const credits = genResult?.remainingCredits;

            if (operationName) {
                log(`Operation: ${operationName}`);
                log(`Initial status: ${status}`);
                if (credits !== undefined) log(`Remaining credits: ${credits}`);
            }

            if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                const vid = genResult.operations[0].operation?.metadata?.video;
                if (vid?.fifeUrl) {
                    log('Step 9-10/11: ✓ Video Generated Immediately!');
                    log('');
                    log('═══ VIDEO WITH MEDIA GENERATION COMPLETE ═══');
                    return { success: true, data: genResult, videoType: 'media', logs: statusLog };
                }
            }

            log('Step 9-10/11: ✓ Generation Submitted (PENDING)');
        } catch (err) {
            const errData = err.response ? `Status ${err.response.status}: ${safeJson(err.response.data)}` : err.message;
            log(`Step 9-10/11: ERROR — ${errData}`);
            throw err;
        }
        log('');

        // Step 11: Poll for completion
        log('── Step 11/11: Poll Video Operation ──');
        log(`Polling operation: ${operationName}`);
        log('Video generation can take 1-5 minutes...');
        let finalData = genResult;
        try {
            // Extract initial operations array from generation response for polling
            const initialOps = (genResult?.operations || []).map(o => ({
                operation: { name: o.operation?.name },
                sceneId: o.sceneId || '',
                status: o.status || 'MEDIA_GENERATION_STATUS_PENDING'
            }));

            const pollResult = await pollVideoOperation(projectId, operationName, bearerToken, log, 120, 5000, initialOps);
            log(`Poll result: ${trunc(safeJson(pollResult), 400)}`);

            if (pollResult.video?.fifeUrl) {
                log(`── Video Result ──`);
                log(`  fifeUrl: ${pollResult.video.fifeUrl}`);
                log(`  seed: ${pollResult.video.seed}`);
                log(`  model: ${pollResult.video.model}`);
                if (pollResult.video.servingBaseUri) {
                    log(`  thumbnail: ${pollResult.video.servingBaseUri}`);
                }
            }

            // Merge poll result into data for downloader
            if (pollResult.fullResult) {
                finalData = pollResult.fullResult;
            } else if (pollResult.video) {
                finalData = {
                    ...genResult,
                    operations: [{
                        operation: {
                            name: operationName,
                            metadata: { video: pollResult.video }
                        },
                        status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
                    }]
                };
            }

            log('Step 11/11: ✓ Video Ready!');
        } catch (err) {
            log(`Step 11/11: ERROR — ${err.message}`);
            throw err;
        }

        log('');
        log('═══ VIDEO WITH MEDIA GENERATION COMPLETE ═══');

        return {
            success: true,
            data: finalData,
            videoType: 'media',
            logs: statusLog
        };
    } catch (error) {
        log('');
        log(`═══ VIDEO WITH MEDIA GENERATION FAILED ═══`);
        log(`Error type: ${error.constructor.name}`);
        log(`Error message: ${error.message}`);
        if (error.response) {
            log(`HTTP Status: ${error.response.status}`);
            log(`Response data: ${trunc(safeJson(error.response.data), 500)}`);
        }
        if (error.stack) {
            log(`Stack: ${error.stack.split('\n').slice(0, 3).join(' → ')}`);
        }
        return {
            success: false,
            error: error.message,
            videoType: 'media',
            logs: statusLog
        };
    } finally {
        sessionManager.releaseAccount(account.id);
    }
}

module.exports = {
    searchProjectScenes,
    submitBatchLog,
    preflightBatchGenerate,
    batchGenerateImages,
    getBearerToken,
    generateImage,
    generateSessionId,
    fetchUserAcknowledgement,
    submitUploadBatchLog,
    preflightUploadUserImage,
    uploadUserImage,
    generateImageWithMedia,
    generateImageWithMultiMedia,
    // Video exports
    batchAsyncGenerateVideoText,
    batchAsyncGenerateVideoRefImages,
    pollVideoOperation,
    generateVideo,
    generateVideoWithMedia
};
