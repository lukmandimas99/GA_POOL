const axios = require('axios');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

/**
 * Ensure output directory exists
 */
function ensureOutputDir(outputDir = OUTPUT_DIR) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
}

/**
 * Slugify a prompt for use in filenames
 */
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 50);
}

function sanitizeFileName(text) {
    return String(text || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 120);
}

function buildUniqueFilePath(outputDir, desiredFilename) {
    const parsed = path.parse(desiredFilename);
    const ext = parsed.ext || '';
    const base = parsed.name || 'file';

    let attempt = 0;
    let filename = desiredFilename;
    let filepath = path.join(outputDir, filename);

    while (fs.existsSync(filepath)) {
        attempt += 1;
        filename = `${base}_${attempt}${ext}`;
        filepath = path.join(outputDir, filename);
    }

    return { filename, filepath };
}

/**
 * Download image from fifeUrl to output folder
 */
async function downloadImage(fifeUrl, prompt, seed, options = {}) {
    const outputDir = options.outputDir || OUTPUT_DIR;
    const shouldDuplicateToDefault = Boolean(options.duplicateToDefault) && outputDir !== OUTPUT_DIR;
    ensureOutputDir(outputDir);

    const slug = slugify(prompt);
    const timestamp = Date.now();
    const customBase = sanitizeFileName(options.fileBaseName || '');
    const customSuffix = sanitizeFileName(options.fileSuffix || '');
    const baseName = customBase
        ? `${customBase}${customSuffix ? `_${customSuffix}` : ''}`
        : `${slug}_${seed}_${timestamp}`;
    const desiredFilename = `${baseName}.png`;
    const { filename, filepath } = buildUniqueFilePath(outputDir, desiredFilename);

    const response = await axios({
        method: 'GET',
        url: fifeUrl,
        responseType: 'arraybuffer',
        headers: {
            'accept': 'image/*,*/*',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        }
    });

    fs.writeFileSync(filepath, response.data);

    if (shouldDuplicateToDefault) {
        ensureOutputDir(OUTPUT_DIR);
        const mirrorTarget = buildUniqueFilePath(OUTPUT_DIR, filename);
        fs.writeFileSync(mirrorTarget.filepath, response.data);
    }

    return {
        filename,
        filepath,
        size: response.data.length
    };
}

/**
 * Extract image URLs from generation response and download all
 */
async function downloadAllImages(generationResult, prompt, options = {}) {
    const downloads = [];

    if (generationResult.media && generationResult.media.length > 0) {
        for (let i = 0; i < generationResult.media.length; i++) {
            const media = generationResult.media[i];
            const fifeUrl = media.image?.generatedImage?.fifeUrl;
            const seed = media.image?.generatedImage?.seed;

            if (fifeUrl) {
                const hasMulti = generationResult.media.length > 1;
                const result = await downloadImage(fifeUrl, prompt, seed || 0, {
                    ...options,
                    fileSuffix: hasMulti ? String(i + 1) : ''
                });
                downloads.push({
                    ...result,
                    fifeUrl,
                    seed,
                    mediaId: media.image?.generatedImage?.mediaGenerationId
                });
            }
        }
    }

    return downloads;
}

/**
 * Download video from fifeUrl to output folder
 */
async function downloadVideo(fifeUrl, prompt, seed, options = {}) {
    const outputDir = options.outputDir || OUTPUT_DIR;
    const shouldDuplicateToDefault = Boolean(options.duplicateToDefault) && outputDir !== OUTPUT_DIR;
    ensureOutputDir(outputDir);

    const slug = slugify(prompt);
    const timestamp = Date.now();
    const customBase = sanitizeFileName(options.fileBaseName || '');
    const customSuffix = sanitizeFileName(options.fileSuffix || '');
    const baseName = customBase
        ? `${customBase}${customSuffix ? `_${customSuffix}` : ''}`
        : `${slug}_${seed}_${timestamp}`;
    const desiredFilename = `${baseName}.mp4`;
    const { filename, filepath } = buildUniqueFilePath(outputDir, desiredFilename);

    const response = await axios({
        method: 'GET',
        url: fifeUrl,
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: {
            'accept': 'video/*,*/*',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        }
    });

    fs.writeFileSync(filepath, response.data);

    if (shouldDuplicateToDefault) {
        ensureOutputDir(OUTPUT_DIR);
        const mirrorTarget = buildUniqueFilePath(OUTPUT_DIR, filename);
        fs.writeFileSync(mirrorTarget.filepath, response.data);
    }

    return {
        filename,
        filepath,
        size: response.data.length
    };
}

/**
 * Extract video URLs from generation response and download all
 */
async function downloadAllVideos(generationResult, prompt, options = {}) {
    const downloads = [];

    if (generationResult.operations && generationResult.operations.length > 0) {
        for (let i = 0; i < generationResult.operations.length; i++) {
            const op = generationResult.operations[i];
            const vid = op.operation?.metadata?.video;
            if (vid && vid.fifeUrl) {
                const hasMulti = generationResult.operations.length > 1;
                const result = await downloadVideo(vid.fifeUrl, prompt, vid.seed || 0, {
                    ...options,
                    fileSuffix: hasMulti ? String(i + 1) : ''
                });
                downloads.push({
                    ...result,
                    fifeUrl: vid.fifeUrl,
                    seed: vid.seed,
                    model: vid.model,
                    thumbnailUrl: vid.servingBaseUri || null,
                    mediaId: vid.mediaGenerationId
                });
            }
        }
    }

    return downloads;
}

module.exports = { downloadImage, downloadAllImages, downloadVideo, downloadAllVideos, ensureOutputDir, OUTPUT_DIR };
