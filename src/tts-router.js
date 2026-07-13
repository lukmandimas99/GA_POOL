/**
 * TTS Router — Google AI Studio TTS endpoints
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const {
    AVAILABLE_VOICES,
    AVAILABLE_STYLES,
    AVAILABLE_PACES,
    AVAILABLE_ACCENTS,
    DEFAULT_SCENE,
    DEFAULT_SAMPLE_CONTEXT,
} = require('./tts-session');

const router = express.Router();

const GEN_DIR = path.join(__dirname, '..', 'audio', 'generations');
const INDEX_FILE = path.join(GEN_DIR, 'index.json');
const PREVIEW_DIR = path.join(GEN_DIR, 'preview');

// Ensure directories exist
if (!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR, { recursive: true });
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');

// Clean up generations folder on startup (excluding preview/ and index.json)
try {
    const files = fs.readdirSync(GEN_DIR, { withFileTypes: true });
    for (const file of files) {
        if (file.isFile() && file.name.endsWith('.wav')) {
            fs.unlinkSync(path.join(GEN_DIR, file.name));
        }
    }
    fs.writeFileSync(INDEX_FILE, '[]');
} catch (err) {
    console.error('[TTS Router] Failed to clean generations on startup:', err.message);
}

// ---------- Helper: Persistent history ----------
function readHistory() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function writeHistory(arr) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(arr, null, 2));
}

function addHistoryEntry(entry) {
    const arr = readHistory();
    arr.unshift(entry);
    while (arr.length > 200) {
        const old = arr.pop();
        if (old?.file) {
            try { fs.unlinkSync(path.join(GEN_DIR, old.file)); } catch {}
        }
    }
    writeHistory(arr);
}

function deleteHistoryEntry(id) {
    const arr = readHistory();
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const [removed] = arr.splice(idx, 1);
    if (removed?.file) {
        try { fs.unlinkSync(path.join(GEN_DIR, removed.file)); } catch {}
    }
    writeHistory(arr);
    return true;
}

// ---------- Stream and Purge ----------
function streamAndPurge(filePath, mime, res, onDone) {
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'audio file no longer exists on disk' });
    }
    res.type(mime);
    const stream = fs.createReadStream(filePath);
    let finished = false;
    const cleanup = () => {
        if (finished) return;
        finished = true;
        try { fs.unlinkSync(filePath); } catch (e) {
            if (e && e.code !== 'ENOENT') console.error(`[TTS Router] unlink failed: ${e.message}`);
        }
        if (typeof onDone === 'function') {
            try { onDone(); } catch (e) { console.error(`[TTS Router] onDone failed: ${e.message}`); }
        }
    };
    stream.on('end', cleanup);
    res.on('close', () => { if (!res.writableFinished) cleanup(); });
    stream.on('error', (err) => {
        console.error(`[TTS Router] stream error: ${err.message}`);
        if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
}

// ---------- Unified generate dispatcher ----------
async function dispatchGenerate(req, payload) {
    const pool = req.app.locals.ttsPool;
    if (!pool) {
        throw new Error('No active or valid Google accounts configured for TTS in pool');
    }
    return pool.submit(payload);
}

async function runGeneration(req, payload = {}) {
    const {
        text,
        voice,
        style,
        pace,
        accent,
        audioProfile,
        scene,
        sampleContext,
        stage,
        dryRun,
    } = payload;

    const t0 = Date.now();
    const result = await dispatchGenerate(req, {
        text,
        voice,
        dryRun: !!dryRun,
        stage: stage || null,
        scene,
        sampleContext,
        style,
        pace,
        accent,
        audioProfile,
    });

    if (result && result.stage) {
        const durMs = Date.now() - t0;
        return {
            id: null,
            file: null,
            ts: Date.now(),
            url: null,
            text,
            voice: voice || null,
            size: 0,
            durMs,
            stage: result.stage,
            ok: !!result.ok,
        };
    }
    if (result && result.dryRun) {
        const durMs = Date.now() - t0;
        return {
            id: null,
            file: null,
            ts: Date.now(),
            url: null,
            text,
            voice: voice || null,
            size: 0,
            durMs,
            dryRun: true,
        };
    }

    const wav = result;
    const durMs = Date.now() - t0;
    const id = crypto.randomBytes(8).toString('hex');
    const ts = Date.now();
    const safeVoice = (voice || 'default').replace(/[^A-Za-z0-9_-]/g, '');
    const file = `${ts}-${safeVoice}-${id}.wav`;
    fs.writeFileSync(path.join(GEN_DIR, file), wav);

    const entry = {
        id, file, ts,
        url: `/audio/${file}`,
        text,
        voice: voice || null,
        size: wav.length,
        durMs,
    };
    addHistoryEntry(entry);
    return entry;
}

// ---------- Job Queue ----------
const jobs = new Map();
const jobQueue = [];
let activeWorkers = 0;

function snapshotJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        queuePosition: job.status === 'queued' ? jobQueue.indexOf(job.id) : -1,
        request: {
            text: job.payload?.text || '',
            voice: job.payload?.voice || null,
            style: job.payload?.style || null,
            pace: job.payload?.pace || null,
            accent: job.payload?.accent || null,
            audioProfile: job.payload?.audioProfile ?? null,
        },
        result: job.result || null,
        error: job.error || null,
    };
}

function enqueueJob(req, payload) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = {
        id,
        status: 'queued',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        payload,
        result: null,
        error: null,
    };
    jobs.set(id, job);
    jobQueue.push(id);
    scheduleJobWorker(req);
    return job;
}

function scheduleJobWorker(req) {
    const pool = req.app.locals.ttsPool;
    const maxConcurrent = pool ? pool.workers.length : 1;
    while (activeWorkers < maxConcurrent && jobQueue.length) {
        activeWorkers++;
        const id = jobQueue.shift();
        if (!id) {
            activeWorkers--;
            break;
        }
        const job = jobs.get(id);
        if (!job || job.status !== 'queued') {
            activeWorkers--;
            continue;
        }

        job.status = 'running';
        job.startedAt = Date.now();

        runGeneration(req, job.payload)
            .then((result) => {
                job.result = result;
                job.status = 'completed';
                job.completedAt = Date.now();
            })
            .catch((e) => {
                job.error = e.message || String(e);
                job.status = 'failed';
                job.completedAt = Date.now();
            })
            .finally(() => {
                activeWorkers--;
                if (jobQueue.length) scheduleJobWorker(req);
            });
    }
}

// Prune old jobs periodically (1 hour retention)
setInterval(() => {
    const cutoff = Date.now() - (60 * 60 * 1000);
    for (const [id, job] of jobs) {
        if ((job.status === 'completed' || job.status === 'failed') && job.completedAt && job.completedAt < cutoff) {
            jobs.delete(id);
        }
    }
}, 5 * 60 * 1000).unref();

// ---------- Endpoints ----------

// GET /api/tts/voices
router.get('/tts/voices', (req, res) => {
    res.json({ voices: AVAILABLE_VOICES });
});

// GET /api/tts/options
router.get('/tts/options', (req, res) => {
    res.json({
        voices: AVAILABLE_VOICES,
        styles: AVAILABLE_STYLES,
        paces: AVAILABLE_PACES,
        accents: AVAILABLE_ACCENTS,
        defaults: {
            scene: DEFAULT_SCENE,
            sampleContext: DEFAULT_SAMPLE_CONTEXT,
            style: 'Vocal Smile',
            pace: 'Natural',
            accent: 'American (Gen)',
            audioProfile: '',
        },
    });
});

// GET /api/tts/status
router.get('/tts/status', (req, res) => {
    const pool = req.app.locals.ttsPool;
    let state;
    if (pool) {
        const ps = pool.getState();
        state = {
            ready: ps.workers.some((w) => w.sessionReady || !w.busy),
            busy: ps.activeJobs > 0,
            hasProfile: true,
            poolSize: ps.poolSize,
            activeJobs: ps.activeJobs,
            queueLength: ps.queueLength,
            mode: 'pool',
        };
    } else {
        state = { ready: false, busy: false, mode: 'none', hasProfile: false };
    }
    res.json({
        ...state,
        headless: config.TTS_HEADLESS,
        keepSession: config.TTS_KEEP_SESSION,
    });
});

// GET /api/tts/history
router.get('/tts/history', (req, res) => {
    res.json({ items: readHistory() });
});

// DELETE /api/tts/history/:id
router.delete('/tts/history/:id', (req, res) => {
    const ok = deleteHistoryEntry(req.params.id);
    res.json({ ok });
});

// POST /api/tts/history/clear
router.post('/tts/history/clear', (req, res) => {
    const arr = readHistory();
    for (const it of arr) {
        if (it.file) {
            try { fs.unlinkSync(path.join(GEN_DIR, it.file)); } catch {}
        }
    }
    writeHistory([]);
    res.json({ ok: true });
});

// GET /audio/:file -> served via root app static or local streaming
router.get('/audio/:file', (req, res) => {
    const safeName = path.basename(req.params.file || '');
    if (!safeName || safeName === '.' || safeName === '..') {
        return res.status(400).json({ error: 'invalid filename' });
    }
    const fp = path.join(GEN_DIR, safeName);
    streamAndPurge(fp, 'audio/wav', res, () => {
        const arr = readHistory();
        const idx = arr.findIndex((x) => x.file === safeName);
        if (idx >= 0) {
            arr.splice(idx, 1);
            writeHistory(arr);
        }
    });
});

// GET /preview-audio/:file
router.get('/preview-audio/:file', (req, res) => {
    const safeName = path.basename(req.params.file || '');
    if (!safeName || safeName === '.' || safeName === '..') {
        return res.status(400).json({ error: 'invalid filename' });
    }
    const fp = path.join(PREVIEW_DIR, safeName);
    if (!fs.existsSync(fp)) {
        return res.status(404).json({ error: 'preview file not found' });
    }
    res.type('audio/wav');
    res.sendFile(fp);
});

// POST /api/tts/preview-voice
router.post('/tts/preview-voice', async (req, res) => {
    const {
        text,
        voice,
        force,
        previewKey,
        style,
        pace,
        accent,
        audioProfile,
        scene,
        sampleContext
    } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text wajib diisi' });
    }
    if (text.length > 2000) {
        return res.status(400).json({ error: 'text preview terlalu panjang (max 2000 chars)' });
    }

    const safeVoice = (voice || 'default').replace(/[^A-Za-z0-9_-]/g, '');
    const safeKey = String(previewKey || 'default').replace(/[^A-Za-z0-9_-]/g, '').toLowerCase() || 'default';

    const payloadStr = JSON.stringify({
        text,
        style: style || '',
        pace: pace || '',
        accent: accent || '',
        audioProfile: audioProfile || '',
        scene: scene || '',
        sampleContext: sampleContext || ''
    });
    const hash = crypto.createHash('md5').update(payloadStr).digest('hex').slice(0, 8);
    const file = `preview-${safeVoice}-${safeKey}-${hash}.wav`;
    const filePath = path.join(PREVIEW_DIR, file);

    if (!force && fs.existsSync(filePath)) {
        const st = fs.statSync(filePath);
        return res.json({
            id: null,
            file,
            ts: st.mtimeMs,
            url: `/api/preview-audio/${file}`,
            text,
            voice: voice || null,
            size: st.size,
            durMs: 0,
            preview: true,
            cached: true,
        });
    }

    try {
        const t0 = Date.now();
        const wav = await dispatchGenerate(req, {
            text,
            voice,
            style,
            pace,
            accent,
            audioProfile,
            scene,
            sampleContext,
            deleteRawDownload: true
        });
        const durMs = Date.now() - t0;
        fs.writeFileSync(filePath, wav);
        res.json({
            id: null,
            file,
            ts: Date.now(),
            url: `/api/preview-audio/${file}`,
            text,
            voice: voice || null,
            size: wav.length,
            durMs,
            preview: true,
            cached: false,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- Sync generate ----------
const handleGenerateSync = async (req, res) => {
    const { text, voice, dryRun, stage, scene, sampleContext, style, pace, accent, audioProfile } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text wajib diisi' });
    }
    if (text.length > 5000) {
        return res.status(400).json({ error: 'text terlalu panjang (max 5000 chars)' });
    }

    try {
        const result = await runGeneration(req, {
            text, voice, dryRun, stage, scene, sampleContext, style, pace, accent, audioProfile,
        });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

router.post('/tts/generate', handleGenerateSync);
router.post('/generate', handleGenerateSync);

// ---------- Job-based Async API ----------
function validateGeneratePayload(body) {
    const text = body && body.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'text wajib diisi' };
    }
    if (text.length > 5000) {
        return { ok: false, error: 'text terlalu panjang (max 5000 chars)' };
    }
    const payload = {
        text,
        voice: body.voice || null,
        style: body.style ?? undefined,
        pace: body.pace ?? undefined,
        accent: body.accent ?? undefined,
        audioProfile: typeof body.audioProfile === 'string' ? body.audioProfile : undefined,
        scene: typeof body.scene === 'string' ? body.scene : undefined,
        sampleContext: typeof body.sampleContext === 'string' ? body.sampleContext : undefined,
    };
    return { ok: true, payload };
}

const handleCreateJob = (req, res) => {
    const v = validateGeneratePayload(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    const job = enqueueJob(req, v.payload);
    res.status(202).json(snapshotJob(job));
};

router.post('/v1/tts/jobs', handleCreateJob);
router.post('/v1/jobs', handleCreateJob);

const handleListJobs = (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const statusFilter = req.query.status || null;
    const items = Array.from(jobs.values())
        .filter((j) => !statusFilter || j.status === statusFilter)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(snapshotJob);
    res.json({
        items,
        total: jobs.size,
        queued: jobQueue.length,
        workerBusy: activeWorkers > 0,
    });
};

router.get('/v1/tts/jobs', handleListJobs);
router.get('/v1/jobs', handleListJobs);

const handleGetJob = (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(snapshotJob(job));
};

router.get('/v1/tts/jobs/:id', handleGetJob);
router.get('/v1/jobs/:id', handleGetJob);

const handleGetJobAudio = (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (job.status === 'failed') {
        return res.status(500).json({ error: job.error || 'job failed' });
    }
    if (job.status !== 'completed') {
        return res.status(409).json({ error: `job not ready (status=${job.status})`, status: job.status });
    }
    const file = job.result && job.result.file;
    if (!file) return res.status(404).json({ error: 'audio file missing from job result' });
    const fp = path.join(GEN_DIR, file);
    streamAndPurge(fp, 'audio/wav', res, () => {
        const arr = readHistory();
        const idx = arr.findIndex((x) => x.file === file);
        if (idx >= 0) {
            arr.splice(idx, 1);
            writeHistory(arr);
        }
    });
};

router.get('/v1/tts/jobs/:id/audio', handleGetJobAudio);
router.get('/v1/jobs/:id/audio', handleGetJobAudio);

const handleCancelJob = (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (job.status !== 'queued') {
        return res.status(409).json({ error: `cannot cancel job with status=${job.status}` });
    }
    const idx = jobQueue.indexOf(job.id);
    if (idx >= 0) jobQueue.splice(idx, 1);
    jobs.delete(job.id);
    res.json({ ok: true, id: job.id });
};

router.delete('/v1/tts/jobs/:id', handleCancelJob);
router.delete('/v1/jobs/:id', handleCancelJob);

module.exports = router;
