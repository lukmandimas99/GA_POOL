/**
 * Flow Router — Google Labs Flow endpoints
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const flowApi = require('./flow-api');
const config = require('./config');
const downloader = require('./downloader');
const sessionManager = require('./session-manager');
const bulkParser = require('./bulk-parser');

const router = express.Router();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });
const activeJobs = new Map();

function parseOptionalSeed(seedRaw) {
    if (seedRaw === undefined || seedRaw === null || seedRaw === '') return undefined;
    const n = parseInt(seedRaw, 10);
    return Number.isFinite(n) ? n : undefined;
}


// Helper to determine aspect ratio
function getAspectRatio(size) {
    if (!size) return 'IMAGE_ASPECT_RATIO_PORTRAIT'; // default 9:16
    const [w, h] = size.split('x').map(Number);
    if (w > h) return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    if (w === h) return 'IMAGE_ASPECT_RATIO_SQUARE';
    return 'IMAGE_ASPECT_RATIO_PORTRAIT';
}

// GET /v1/models & /models (OpenAI compatibility)
const handleModels = (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    res.json({
        object: 'list',
        data: [
            { id: 'veo-3.1', object: 'model', created: now, owned_by: 'google' },
            { id: 'NANO_BANANA_2', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'NANO_BANANA_2_LITE', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'NANO_BANANA_PRO', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'veo_3_1_t2v_fast_portrait', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'veo_3_1_r2v_fast_portrait', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_t2v_4s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_t2v_6s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_t2v_8s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_t2v_10s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_i2v_4s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_i2v_6s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_i2v_8s', object: 'model', created: now, owned_by: 'flow-gateway' },
            { id: 'abra_i2v_10s', object: 'model', created: now, owned_by: 'flow-gateway' }
        ]
    });
};

router.get('/v1/models', handleModels);
router.get('/models', handleModels);

// POST /v1/chat/completions & /chat/completions (OpenAI compatibility)
const handleCompletions = async (req, res) => {
    const { model, messages, size } = req.body;

    if (!messages || !messages.length) {
        return res.status(400).json({ error: { message: 'messages is required' } });
    }

    try {
        const userMsg = messages.find(m => m.role === 'user');
        if (!userMsg) {
            return res.status(400).json({ error: { message: 'No user message found' } });
        }

        let prompt = '';
        let allImages = [];

        if (typeof userMsg.content === 'string') {
            prompt = userMsg.content;
        } else if (Array.isArray(userMsg.content)) {
            for (const part of userMsg.content) {
                if (part.type === 'text') {
                    prompt += (prompt ? '\n' : '') + (part.text || '');
                } else if (part.type === 'image_url' && part.image_url?.url) {
                    const url = part.image_url.url;
                    if (url.startsWith('data:image')) {
                        allImages.push(url.replace(/^data:image\/\w+;base64,/, ''));
                    }
                }
            }
        }

        if (!prompt) {
            return res.status(400).json({ error: { message: 'No prompt text found in messages' } });
        }

        const isVideo = model && model.toLowerCase().includes('veo');
        const options = {
            aspectRatio: getAspectRatio(size),
            model
        };

        let result;
        if (isVideo && allImages.length > 0) {
            result = await flowApi.generateVideoWithMedia(prompt, allImages[0], 1024, 1024, options);
        } else if (isVideo) {
            result = await flowApi.generateVideo(prompt, options);
        } else if (allImages.length > 0) {
            result = await flowApi.generateImageWithMedia(prompt, allImages[0], 1024, 1024, options);
        } else {
            result = await flowApi.generateImage(prompt, options);
        }

        if (!result || !result.success) {
            return res.status(500).json({ error: { message: result?.error || 'Generation failed' } });
        }

        let contentParts = [];
        if (!isVideo) {
            const downloads = await downloader.downloadAllImages(result.data, prompt);
            for (const dl of downloads) {
                try {
                    const imgBuffer = fs.readFileSync(dl.filepath);
                    const base64 = imgBuffer.toString('base64');
                    const ext = path.extname(dl.filename).replace('.', '') || 'png';
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: `data:image/${ext};base64,${base64}` }
                    });
                } catch (e) {
                    console.error(`[FlowRouter] Read failed: ${e.message}`);
                }
            }
        } else {
            const downloads = await downloader.downloadAllVideos(result.data, prompt);
            for (const dl of downloads) {
                contentParts.push({
                    type: 'text',
                    text: `Video saved: ${dl.filename}`
                });
            }
        }

        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'imagen-3',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: contentParts },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: prompt.length,
                completion_tokens: 1,
                total_tokens: prompt.length + 1
            }
        });

    } catch (err) {
        res.status(500).json({ error: { message: err.message } });
    }
};

router.post('/v1/chat/completions', handleCompletions);
router.post('/chat/completions', handleCompletions);

// POST /api/flow/generate
router.post('/flow/generate', async (req, res) => {
    const { prompt, aspectRatio, model } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });
    try {
        const result = await flowApi.generateImage(prompt, { aspectRatio, model });
        if (result.success) {
            const downloads = await downloader.downloadAllImages(result.data, prompt);
            res.json({ success: true, data: downloads });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/flow/generate-video
router.post('/flow/generate-video', async (req, res) => {
    const { prompt, aspectRatio, model } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });
    try {
        const result = await flowApi.generateVideo(prompt, { aspectRatio, model });
        if (result.success) {
            const downloads = await downloader.downloadAllVideos(result.data, prompt);
            res.json({ success: true, data: downloads });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/flow/generate-with-media
router.post('/flow/generate-with-media', async (req, res) => {
    const { prompt, imageBase64, width, height, aspectRatio, model } = req.body;
    if (!prompt || !imageBase64) return res.status(400).json({ success: false, error: 'prompt and imageBase64 are required' });
    try {
        const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const result = await flowApi.generateImageWithMedia(prompt, cleanBase64, width || 1024, height || 1024, { aspectRatio, model });
        if (result.success) {
            const downloads = await downloader.downloadAllImages(result.data, prompt);
            res.json({ success: true, data: downloads });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/flow/generate-video-with-media
router.post('/flow/generate-video-with-media', async (req, res) => {
    const { prompt, imageBase64, width, height, aspectRatio, model } = req.body;
    if (!prompt || !imageBase64) return res.status(400).json({ success: false, error: 'prompt and imageBase64 are required' });
    try {
        const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const result = await flowApi.generateVideoWithMedia(prompt, cleanBase64, width || 1024, height || 1024, { aspectRatio, model });
        if (result.success) {
            const downloads = await downloader.downloadAllVideos(result.data, prompt);
            res.json({ success: true, data: downloads });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/flow/status
router.get('/flow/status', (req, res) => {
    res.json({
        success: true,
        hasValidAccounts: sessionManager.hasValidAccounts(),
        accountsCount: sessionManager.getAccountCount(),
        roundRobin: sessionManager.isRoundRobinEnabled()
    });
});

// ==========================================
// BULK GENERATION & JOBS EMULATION
// ==========================================

router.post('/bulk/generate', upload.any(), async (req, res) => {
    try {
        const uploadedFile = (Array.isArray(req.files) ? req.files : []).find(f =>
            f.fieldname === 'promptsFile' || f.fieldname === 'excelFile' || f.fieldname === 'file'
        );
        const hasFile = !!(uploadedFile && uploadedFile.buffer);
        const promptsTextRaw = typeof req.body.promptsText === 'string' ? req.body.promptsText : '';
        const hasText = promptsTextRaw.trim().length > 0;

        if (!hasFile && !hasText) {
            return res.status(400).json({ error: 'promptsFile (csv/json/jsonl/txt) or promptsText is required' });
        }
        if (hasFile && hasText) {
            return res.status(400).json({ error: 'Pakai salah satu sumber: file ATAU promptsText, tidak boleh dua-duanya.' });
        }

        let promptRows = [];
        let inputSource = '';
        if (hasFile) {
            try {
                const parsed = bulkParser.parseBuffer(uploadedFile.buffer, {
                    filename: uploadedFile.originalname || '',
                    mimetype: uploadedFile.mimetype || '',
                    format: req.body.format
                });
                promptRows = parsed.items;
                inputSource = parsed.format;
            } catch (parseErr) {
                return res.status(400).json({ error: `Failed to parse prompt file: ${parseErr.message}` });
            }
        } else {
            promptRows = bulkParser.parseFromText(promptsTextRaw);
            inputSource = 'text';
        }

        if (promptRows.length === 0) {
            return res.status(400).json({
                error: hasFile
                    ? `No prompts found in uploaded file (parsed as "${inputSource}").`
                    : 'No prompts found in text input'
            });
        }

        const outputType = String(req.body.outputType || 'image').toLowerCase() === 'video' ? 'video' : 'image';
        const mode = String(req.body.mode || 'text').toLowerCase() === 'media' ? 'media' : 'text';
        const cleanBase64 = String(req.body.base64Image || '').includes(',')
            ? String(req.body.base64Image).split(',')[1]
            : String(req.body.base64Image || '');

        if (mode === 'media' && !cleanBase64) {
            return res.status(400).json({ error: 'Reference image is required for media mode' });
        }

        const imageWidth = parseInt(req.body.imageWidth, 10) || 800;
        const imageHeight = parseInt(req.body.imageHeight, 10) || 600;
        const seedValue = parseOptionalSeed(req.body.seed);
        const projectId = req.body.projectId || config.PROJECT_ID;
        const outputDir = String(req.body.outputDir || '').trim();
        const parsedConcurrency = parseInt(req.body.concurrency, 10);
        const parsedMaxRetry = parseInt(req.body.maxRetry, 10);
        const requestedFailurePolicy = String(req.body.failurePolicy || 'defer').toLowerCase();
        const failurePolicy = requestedFailurePolicy === 'stop' ? 'stop' : 'defer';
        const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
            ? Math.min(parsedConcurrency, 10)
            : 5;
        const maxRetry = Number.isFinite(parsedMaxRetry) && parsedMaxRetry >= 0
            ? Math.min(parsedMaxRetry, 5)
            : 1;

        const settings = {
            outputType,
            mode,
            aspectRatio: req.body.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT',
            videoAspectRatio: req.body.videoAspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT',
            model: req.body.model || 'GEM_PIX_2',
            videoModelKey: req.body.videoModelKey || 'veo_3_1_t2v_fast_portrait',
            seed: seedValue,
            projectId,
            outputDir,
            concurrency,
            maxRetry,
            failurePolicy,
            base64Image: cleanBase64,
            imageWidth,
            imageHeight
        };

        const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        activeJobs.set(jobId, {
            status: 'running',
            prompt: `Bulk (${promptRows.length} prompt${promptRows.length > 1 ? 's' : ''}, source=${inputSource})`,
            mode: `bulk-${outputType}-${mode}`,
            logs: [],
            result: null,
            startTime: Date.now()
        });

        res.json({
            jobId,
            status: 'started',
            total: promptRows.length,
            inputSource,
            settings: { outputType, mode, concurrency, maxRetry, failurePolicy }
        });

        (async () => {
            let successCount = 0;
            let failedCount = 0;
            let failedAttemptCount = 0;
            let retriedCount = 0;
            let batchNo = 0;
            let stopRequested = false;
            const finalByRow = new Map();

            const queue = promptRows.map((rowData, idx) => ({
                rowNo: idx + 1,
                prompt: rowData.prompt,
                beat: rowData.beat || `row_${idx + 1}`,
                mode: rowData.mode,
                base64Image: rowData.base64Image,
                attempt: 0
            }));

            const executeItem = async (item, totalBatchesLabel) => {
                const { rowNo, prompt, beat, attempt, mode: itemMode, base64Image: itemBase64Image } = item;
                const tryNo = attempt + 1;
                const job = activeJobs.get(jobId);
                if (!job) throw new Error('Job no longer available');
                if (job.status === 'failed' || job.status === 'cancelled') {
                    throw new Error('Job cancelled or failed');
                }

                job.logs.push({
                    time: new Date().toISOString(),
                    message: `[Bulk ${rowNo}/${promptRows.length}] [Batch ${totalBatchesLabel}] [Try ${tryNo}] Starting (${beat}): ${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}`
                });

                try {
                    let generationResult;
                    const pushLog = (logEntry) => {
                        const currentJob = activeJobs.get(jobId);
                        if (currentJob) {
                            currentJob.logs.push({
                                time: logEntry.time || new Date().toISOString(),
                                message: `[Bulk ${rowNo}/${promptRows.length}] [Batch ${totalBatchesLabel}] [Try ${tryNo}] ${logEntry.message}`
                            });
                        }
                    };

                    const resolvedMode = itemMode || settings.mode;
                    let resolvedBase64 = itemBase64Image || settings.base64Image;
                    if (resolvedBase64 && resolvedBase64.includes(',')) {
                        resolvedBase64 = resolvedBase64.split(',')[1];
                    }

                    if (settings.outputType === 'video' && resolvedMode === 'media') {
                        if (!resolvedBase64) throw new Error('Reference image is required for media mode');
                        generationResult = await flowApi.generateVideoWithMedia(
                            prompt,
                            resolvedBase64,
                            settings.imageWidth,
                            settings.imageHeight,
                            {
                                aspectRatio: settings.videoAspectRatio,
                                videoModelKey: settings.videoModelKey,
                                seed: settings.seed,
                                projectId: settings.projectId
                            },
                            pushLog
                        );
                    } else if (settings.outputType === 'video') {
                        generationResult = await flowApi.generateVideo(prompt, {
                            aspectRatio: settings.videoAspectRatio,
                            videoModelKey: settings.videoModelKey,
                            seed: settings.seed,
                            projectId: settings.projectId
                        }, pushLog);
                    } else if (resolvedMode === 'media') {
                        if (!resolvedBase64) throw new Error('Reference image is required for media mode');
                        generationResult = await flowApi.generateImageWithMedia(
                            prompt,
                            resolvedBase64,
                            settings.imageWidth,
                            settings.imageHeight,
                            {
                                aspectRatio: settings.aspectRatio,
                                model: settings.model,
                                seed: settings.seed,
                                projectId: settings.projectId
                            },
                            pushLog
                        );
                    } else {
                        generationResult = await flowApi.generateImage(prompt, {
                            aspectRatio: settings.aspectRatio,
                            model: settings.model,
                            seed: settings.seed,
                            projectId: settings.projectId
                        }, pushLog);
                    }

                    if (!generationResult || !generationResult.success || !generationResult.data) {
                        throw new Error(generationResult?.error || 'Generation failed');
                    }

                    let downloads = [];
                    if (settings.outputType === 'video') {
                        downloads = await downloader.downloadAllVideos(generationResult.data, prompt, {
                            outputDir: settings.outputDir,
                            fileBaseName: beat,
                            duplicateToDefault: false
                        });
                    } else {
                        downloads = await downloader.downloadAllImages(generationResult.data, prompt, {
                            outputDir: settings.outputDir,
                            fileBaseName: beat,
                            duplicateToDefault: false
                        });
                    }

                    const currentJob = activeJobs.get(jobId);
                    if (currentJob) {
                        currentJob.logs.push({
                            time: new Date().toISOString(),
                            message: `[Bulk ${rowNo}/${promptRows.length}] [Batch ${totalBatchesLabel}] [Try ${tryNo}] Completed ✓ (${downloads.length} file${downloads.length > 1 ? 's' : ''})`
                        });
                    }

                    return {
                        ok: true,
                        rowNo,
                        beat,
                        prompt,
                        attempts: tryNo,
                        downloads: downloads.map(d => d.filename)
                    };
                } catch (error) {
                    const currentJob = activeJobs.get(jobId);
                    if (currentJob) {
                        currentJob.logs.push({
                            time: new Date().toISOString(),
                            message: `[Bulk ${rowNo}/${promptRows.length}] [Batch ${totalBatchesLabel}] [Try ${tryNo}] Failed: ${error.message}`
                        });
                    }

                    return {
                        ok: false,
                        rowNo,
                        beat,
                        prompt,
                        attempts: tryNo,
                        error: error.message
                    };
                }
            };

            while (queue.length > 0 && !stopRequested) {
                batchNo += 1;
                const batch = queue.splice(0, settings.concurrency);
                const batchLabel = `${batchNo}`;
                const job = activeJobs.get(jobId);
                if (!job || job.status === 'failed' || job.status === 'cancelled') return;

                job.logs.push({
                    time: new Date().toISOString(),
                    message: `[Bulk] Starting batch ${batchLabel} with ${batch.length} item(s).`
                });

                const results = await Promise.all(batch.map((item) => executeItem(item, batchLabel)));

                const jobCheck = activeJobs.get(jobId);
                if (!jobCheck || jobCheck.status === 'failed' || jobCheck.status === 'cancelled') return;

                for (const result of results) {
                    if (result.ok) {
                        successCount += 1;
                        finalByRow.set(result.rowNo, {
                            row: result.rowNo,
                            beat: result.beat,
                            prompt: result.prompt,
                            success: true,
                            attempts: result.attempts,
                            downloads: result.downloads
                        });
                        continue;
                    }

                    failedAttemptCount += 1;
                    if (settings.failurePolicy === 'stop') {
                        failedCount += 1;
                        finalByRow.set(result.rowNo, {
                            row: result.rowNo,
                            beat: result.beat,
                            prompt: result.prompt,
                            success: false,
                            attempts: result.attempts,
                            error: result.error
                        });
                        stopRequested = true;
                        const currentJob = activeJobs.get(jobId);
                        if (currentJob) {
                            currentJob.logs.push({
                                time: new Date().toISOString(),
                                message: `[Bulk] stopOnError active. Stopping after failure at row ${result.rowNo}.`
                            });
                        }
                        continue;
                    }

                    const canRetry = result.attempts <= settings.maxRetry;
                    if (canRetry) {
                        retriedCount += 1;
                        queue.push({
                            rowNo: result.rowNo,
                            prompt: result.prompt,
                            beat: result.beat,
                            attempt: result.attempts
                        });
                        const currentJob = activeJobs.get(jobId);
                        if (currentJob) {
                            currentJob.logs.push({
                                time: new Date().toISOString(),
                                message: `[Bulk ${result.rowNo}/${promptRows.length}] Scheduled retry in next batch (attempt ${result.attempts + 1}/${settings.maxRetry + 1}).`
                            });
                        }
                    } else {
                        failedCount += 1;
                        finalByRow.set(result.rowNo, {
                            row: result.rowNo,
                            beat: result.beat,
                            prompt: result.prompt,
                            success: false,
                            attempts: result.attempts,
                            error: result.error
                        });
                    }
                }

                if (stopRequested) {
                    break;
                }
            }

            if (stopRequested && queue.length > 0) {
                const currentJob = activeJobs.get(jobId);
                if (currentJob) {
                    currentJob.logs.push({
                        time: new Date().toISOString(),
                        message: `[Bulk] ${queue.length} pending item(s) skipped due to stop policy.`
                    });
                }
            }

            const finalJob = activeJobs.get(jobId);
            if (!finalJob) return;

            const items = Array.from(finalByRow.values()).sort((a, b) => a.row - b.row);

            finalJob.status = failedCount > 0 ? 'failed' : 'completed';
            finalJob.result = {
                bulk: true,
                success: failedCount === 0,
                total: promptRows.length,
                processed: items.length,
                completed: successCount,
                failed: failedCount,
                failedAttempts: failedAttemptCount,
                retriesScheduled: retriedCount,
                concurrency: settings.concurrency,
                maxRetry: settings.maxRetry,
                failurePolicy: settings.failurePolicy,
                outputType: settings.outputType,
                mode: settings.mode,
                outputDir: settings.outputDir || downloader.OUTPUT_DIR,
                inputSource,
                items
            };

            finalJob.logs.push({
                time: new Date().toISOString(),
                message: `[Bulk] Done. Success: ${successCount}, Failed: ${failedCount}`
            });
        })().catch((err) => {
            const failedJob = activeJobs.get(jobId);
            if (!failedJob) return;
            failedJob.status = 'failed';
            failedJob.result = { bulk: true, success: false, error: err.message };
            failedJob.logs.push({ time: new Date().toISOString(), message: `[Bulk] Fatal error: ${err.message}` });
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

router.get('/job/:jobId', (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
        jobId: req.params.jobId,
        status: job.status,
        prompt: job.prompt,
        logs: job.logs,
        result: job.result,
        elapsed: Date.now() - job.startTime
    });
});

router.delete('/job/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = activeJobs.get(jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status === 'running') {
        job.status = 'failed';
        job.result = { success: false, error: 'cancelled' };
        job.logs.push({
            time: new Date().toISOString(),
            message: 'Job cancelled by user request.'
        });
    }
    res.json({ success: true, message: 'Job cancellation requested' });
});

module.exports = router;

