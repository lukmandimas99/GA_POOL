/**
 * Accounts Router — Manage Google accounts and keep-alive
 */

const express = require('express');
const sessionManager = require('./session-manager');
const { openAistudio } = require('./aistudio-activator');
const config = require('./config');

const router = express.Router();

// Active login flows state
let currentLoginFlow = null;

// GET /api/accounts — List all accounts
router.get('/accounts', (req, res) => {
    try {
        const list = sessionManager.listAccounts();
        res.json({ success: true, accounts: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts — Add account with pasted cookies
router.post('/accounts', async (req, res) => {
    const { cookies } = req.body;
    if (!cookies || typeof cookies !== 'string') {
        return res.status(400).json({ success: false, error: 'cookies string is required' });
    }
    try {
        const acc = await sessionManager.addCookieAccount(cookies);
        // Recreate pool to absorb the new account if it's valid
        if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        res.json({ success: true, account: { id: acc.id, label: acc.label, email: acc.email } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/login — Start interactive browser login
router.post('/accounts/login', (req, res) => {
    if (currentLoginFlow && currentLoginFlow.status === 'running') {
        return res.status(409).json({ success: false, error: 'A login flow is already running' });
    }
    const { label } = req.body || {};
    currentLoginFlow = { status: 'running', error: null, accountId: null };

    // Run async so we return 202 immediately
    sessionManager.addAccount(label)
        .then((acc) => {
            currentLoginFlow.status = 'completed';
            currentLoginFlow.accountId = acc.id;
            if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        })
        .catch((err) => {
            currentLoginFlow.status = 'failed';
            currentLoginFlow.error = err.message || String(err);
        });

    res.status(202).json({ success: true, message: 'Browser login started' });
});

// GET /api/accounts/login/status — Poll browser login status
router.get('/accounts/login/status', (req, res) => {
    if (!currentLoginFlow) {
        return res.json({ success: true, status: 'idle' });
    }
    res.json({
        success: true,
        status: currentLoginFlow.status,
        accountId: currentLoginFlow.accountId,
        error: currentLoginFlow.error
    });
});

// POST /api/accounts/:id/activate — Set active account
router.post('/accounts/:id/activate', (req, res) => {
    try {
        sessionManager.setActiveAccount(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(404).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/:id/refresh — Refresh cookies from profile
router.post('/accounts/:id/refresh', async (req, res) => {
    try {
        await sessionManager.extractCookies(req.params.id);
        if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/:id/health — Check session health
router.post('/accounts/:id/health', async (req, res) => {
    try {
        const result = await sessionManager.checkHealth(req.params.id);
        if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/:id/setup-aistudio — Launch Chrome on AI Studio
router.post('/accounts/:id/setup-aistudio', async (req, res) => {
    const profileDir = sessionManager.getAccountProfileDir(req.params.id);
    if (!profileDir) {
        return res.status(404).json({ success: false, error: 'Account profile not found' });
    }
    try {
        const result = await openAistudio(profileDir);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/accounts/:id — Remove account from pool
router.delete('/accounts/:id', (req, res) => {
    try {
        sessionManager.removeAccount(req.params.id, true);
        if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        res.json({ success: true });
    } catch (e) {
        res.status(404).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/refresh-all — Refresh all valid accounts
router.post('/accounts/refresh-all', async (req, res) => {
    try {
        const list = sessionManager.listAccounts();
        let count = 0;
        for (const a of list) {
            if (a.hasCookies && a.status === 'valid') {
                try {
                    await sessionManager.extractCookies(a.id, { silent: true });
                    count++;
                } catch (err) {
                    console.error(`[AccountsRouter] Auto-refresh failed for ${a.label}:`, err.message);
                }
            }
        }
        if (req.app.locals.recreateTtsPool) req.app.locals.recreateTtsPool();
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/keepalive — Update keep-alive interval
router.post('/accounts/keepalive', (req, res) => {
    const { intervalMinutes } = req.body;
    const mins = parseInt(intervalMinutes, 10);
    if (isNaN(mins) || mins < 5) {
        return res.status(400).json({ success: false, error: 'intervalMinutes must be a number >= 5' });
    }
    try {
        sessionManager.stopKeepAlive();
        sessionManager.startKeepAlive(mins * 60 * 1000);
        res.json({ success: true, intervalMinutes: mins });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/accounts/keepalive — Get keep-alive settings
router.get('/accounts/keepalive', (req, res) => {
    res.json({
        success: true,
        running: sessionManager.isKeepAliveRunning(),
        intervalMinutes: config.KEEP_ALIVE_INTERVAL_MINUTES || 30
    });
});

module.exports = router;
