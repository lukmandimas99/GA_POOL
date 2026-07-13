/**
 * GA_POOL — Centralized Google Account Pool & Generation Engine
 * 
 * Port: 4005 (Express)
 * Unified endpoint namespace.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./src/config');
const sessionManager = require('./src/session-manager');
const { TtsPool } = require('./src/tts-pool');
const browserRegistry = require('./src/browser-registry');

const app = express();

// Request logging ring buffer
const trafficLogs = [];
function logTraffic(method, url, status, durationMs, error = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        method,
        url,
        status,
        durationMs,
        error
    };
    trafficLogs.unshift(entry);
    if (trafficLogs.length > 200) trafficLogs.pop();
}

// Middleware: Express json parser
app.use(express.json({ limit: '50mb' }));

// Middleware: CORS
app.use((req, res, next) => {
    const allowed = config.CORS_ALLOWED_ORIGINS.split(',');
    const origin = req.headers.origin;
    if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Middleware: Bearer Token Auth
app.use((req, res, next) => {
    // Skip static assets and dashboard
    if (req.path === '/' || req.path.startsWith('/public/') || req.path.startsWith('/output/') || req.path.startsWith('/audio/') || req.path.startsWith('/api/preview-audio/')) {
        return next();
    }
    
    const secret = config.API_SECRET_KEY;
    if (!secret) return next(); // No secret key configured -> open access
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: missing bearer token' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== secret) {
        return res.status(403).json({ error: 'Forbidden: invalid bearer token' });
    }
    next();
});

// Middleware: Traffic logger wrapper
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - t0;
        logTraffic(req.method, req.originalUrl, res.statusCode, duration);
    });
    next();
});

// Load Routers
const accountsRouter = require('./src/accounts-router');
const flowRouter = require('./src/flow-router');
const ttsRouter = require('./src/tts-router');

// Mount namespaces
app.use('/api', accountsRouter);
app.use('/api', flowRouter);
app.use('/api', ttsRouter);

// Mount top-level /v1 OpenAI compatibility namespaces
app.use('/v1', flowRouter);
app.use('/v1', ttsRouter);
app.use('/', ttsRouter);

// Serve static directories
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));
app.use('/audio', express.static(path.join(__dirname, 'audio', 'generations')));

// GET /api/traffic
app.get('/api/traffic', (req, res) => {
    res.json({ success: true, logs: trafficLogs });
});

// GET /api/health
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        time: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Recreate TTS Pool dynamically when accounts change
app.locals.recreateTtsPool = function () {
    const activeAccounts = sessionManager.listAccounts().filter(a => a.hasCookies && a.status === 'valid');
    const workers = activeAccounts.map(a => ({
        id: a.id,
        profileDir: sessionManager.getAccountProfileDir(a.id)
    }));

    if (app.locals.ttsPool) {
        console.log('[Server] Shutting down old TTS Pool workers...');
        app.locals.ttsPool.shutdown({ hardTimeoutMs: 3000 }).catch(() => {});
    }

    if (workers.length > 0) {
        console.log(`[Server] Initializing TTS Pool with ${workers.length} workers...`);
        app.locals.ttsPool = new TtsPool({
            workers,
            headless: config.TTS_HEADLESS,
            keepSession: config.TTS_KEEP_SESSION,
            onLog: (msg) => console.log(`[TtsPool] ${msg}`)
        });
    } else {
        console.log('[Server] No valid Google accounts available for TTS Pool.');
        app.locals.ttsPool = null;
    }
};

// Graceful Shutdown
let shuttingDown = false;
async function gracefulShutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Server] Shutdown initiated (${reason})…`);
    
    const timer = setTimeout(() => {
        console.log('[Server] Shutdown timed out, forcing exit.');
        process.exit(exitCode || 1);
    }, 5000);
    timer.unref();

    try {
        sessionManager.stopKeepAlive();
        if (app.locals.ttsPool) {
            await app.locals.ttsPool.shutdown({ hardTimeoutMs: 3000 });
        }
        await browserRegistry.closeAll(console.log);
    } catch (e) {
        console.error('[Server] Shutdown error:', e.message);
    } finally {
        clearTimeout(timer);
        process.exit(exitCode);
    }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => gracefulShutdown(sig)); } catch {}
}

// Start Server
const PORT = config.PORT;
const HOST = config.HOST;

console.log('[Server] Initializing Session Manager...');
sessionManager.init();

// Initialize initial TTS Pool
app.locals.recreateTtsPool();

app.listen(PORT, HOST, () => {
    console.log(`================================================================`);
    console.log(` GA_POOL central engine running on http://${HOST}:${PORT}`);
    console.log(` Active accounts loaded: ${sessionManager.getAccountCount()}`);
    console.log(` Keep-Alive interval: ${config.KEEP_ALIVE_INTERVAL_MINUTES} mins`);
    console.log(`================================================================`);
});
