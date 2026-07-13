/**
 * Bulk prompt parser — multi-format.
 *
 * Supported sources:
 *   - CSV    (.csv)                    custom RFC-4180-ish parser (handles quoted cells)
 *   - JSON   (.json)                   array of strings | array of objects | { prompts: [...] }
 *   - JSONL  (.jsonl / .ndjson)        one JSON object/string per line
 *   - TXT    (.txt) / raw text         blank-line separated blocks (legacy behavior)
 *
 * All parsers normalize to:
 *   [{ row: <1-based int>, prompt: <string>, beat: <string|''> }, ...]
 *
 * "beat" is an optional per-row file basename hint used by the downloader.
 *
 * Auto-detection priority:
 *   1. explicit `format` arg (caller knows)
 *   2. file extension
 *   3. MIME type
 *   4. content sniff (starts with '[' or '{' → JSON, etc.)
 */

const path = require('path');

// The `xlsx` (SheetJS) dependency was removed due to an unpatched
// high-severity prototype-pollution / ReDoS advisory with no fix available
// on the npm registry. Excel input is no longer parsed — see
// parseFromExcelBuffer, which throws a guidance error pointing users to CSV.

/* ============================================================
 * Normalizers
 * ============================================================ */

function _coerceRow(rawValue, idx) {
    if (rawValue == null) return null;

    // String shape: just a prompt
    if (typeof rawValue === 'string') {
        const v = rawValue.trim();
        if (!v) return null;
        return { row: idx + 1, prompt: v, beat: '' };
    }

    // Object shape: pick canonical fields, with aliases
    if (typeof rawValue === 'object') {
        const promptKey = ['prompt', 'text', 'content', 'desc', 'description']
            .find(k => typeof rawValue[k] === 'string' && rawValue[k].trim());
        if (!promptKey) return null;

        const beatKey = ['beat', 'name', 'title', 'id', 'filename']
            .find(k => typeof rawValue[k] === 'string' && rawValue[k].trim());

        const rowObj = {
            row: idx + 1,
            prompt: String(rawValue[promptKey]).trim(),
            beat: beatKey ? String(rawValue[beatKey]).trim() : ''
        };

        if (rawValue.mode) {
            rowObj.mode = String(rawValue.mode).trim();
        }
        if (rawValue.base64Image) {
            rowObj.base64Image = String(rawValue.base64Image).trim();
        }

        return rowObj;
    }

    return null;
}

function _normalizeArray(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    let i = 0;
    for (const raw of arr) {
        const row = _coerceRow(raw, i);
        if (row) {
            row.row = out.length + 1; // re-index after filtering empties
            out.push(row);
        }
        i += 1;
    }
    return out;
}

/* ============================================================
 * Format-specific parsers
 * ============================================================ */

function parseFromText(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return [];

    // Blank-line-separated blocks; single newlines stay inside one prompt.
    const blocks = raw.replace(/\r\n/g, '\n').split(/\n\s*\n+/);
    const out = [];
    for (const block of blocks) {
        const v = block.trim();
        if (!v) continue;
        out.push({ row: out.length + 1, prompt: v, beat: '' });
    }
    return out;
}

function parseFromJson(text) {
    const data = JSON.parse(String(text || '').trim() || 'null');
    if (data == null) return [];

    // { prompts: [...] }  | { items: [...] } | { rows: [...] }
    if (!Array.isArray(data) && typeof data === 'object') {
        const containerKey = ['prompts', 'items', 'rows', 'data']
            .find(k => Array.isArray(data[k]));
        if (containerKey) return _normalizeArray(data[containerKey]);
        // single object  →  treat as one row
        const single = _coerceRow(data, 0);
        return single ? [single] : [];
    }

    return _normalizeArray(data);
}

function parseFromJsonl(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const collected = [];
    for (const line of lines) {
        const v = line.trim();
        if (!v) continue;
        try {
            collected.push(JSON.parse(v));
        } catch (_) {
            // tolerate non-JSON lines as plain prompts
            collected.push(v);
        }
    }
    return _normalizeArray(collected);
}

/**
 * Minimal CSV parser supporting:
 *   - quoted cells with embedded commas / newlines / "" escapes
 *   - optional header row (auto-detected: if row[0] cell text matches /prompt|text|content/i)
 *   - column resolution by header name (`prompt`, `beat`); else first non-empty cell = prompt
 */
function parseFromCsv(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    if (!src.trim()) return [];

    const rows = [];
    let cur = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                cell += '"';
                i += 1;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            cur.push(cell);
            cell = '';
        } else if (ch === '\n') {
            cur.push(cell);
            rows.push(cur);
            cur = [];
            cell = '';
        } else {
            cell += ch;
        }
    }
    if (cell.length > 0 || cur.length > 0) {
        cur.push(cell);
        rows.push(cur);
    }

    if (rows.length === 0) return [];

    // Header detection
    const headerRow = rows[0].map(c => String(c || '').trim().toLowerCase());
    const looksLikeHeader = headerRow.some(c => /^(prompt|text|content|beat|name|title|id|filename)$/.test(c));

    let promptIdx = -1, beatIdx = -1;
    let dataStart = 0;
    if (looksLikeHeader) {
        promptIdx = headerRow.findIndex(h => /^(prompt|text|content)$/.test(h));
        if (promptIdx < 0) promptIdx = headerRow.findIndex(h => h.includes('prompt'));
        beatIdx = headerRow.findIndex(h => /^(beat|name|title|id|filename)$/.test(h));
        dataStart = 1;
    }

    const out = [];
    for (let r = dataStart; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        let promptVal = '';
        if (promptIdx >= 0) {
            promptVal = String(row[promptIdx] || '').trim();
        } else {
            promptVal = String(row.find(c => String(c || '').trim() !== '') || '').trim();
        }
        if (!promptVal) continue;

        const beatVal = beatIdx >= 0 ? String(row[beatIdx] || '').trim() : '';
        out.push({ row: out.length + 1, prompt: promptVal, beat: beatVal });
    }
    return out;
}

function parseFromExcelBuffer() {
    // Excel parsing was removed along with the `xlsx` (SheetJS) dependency,
    // which carried an unpatched high-severity prototype-pollution / ReDoS
    // advisory with no fix on the npm registry. Callers should export their
    // spreadsheet to CSV (or JSON) and upload that instead — every other
    // format below is parsed by first-party code.
    throw new Error(
        'Excel (.xlsx/.xls) tidak lagi didukung. Export sheet kamu ke CSV ' +
        '(File → Save As → CSV) atau JSON, lalu upload ulang.'
    );
}

/* ============================================================
 * Auto-detect & dispatch
 * ============================================================ */

function detectFormat({ filename = '', mimetype = '', sample = '' } = {}) {
    const ext = String(path.extname(filename || '')).toLowerCase().replace('.', '');
    if (ext === 'xlsx' || ext === 'xls') return 'excel';
    if (ext === 'csv') return 'csv';
    if (ext === 'json') return 'json';
    if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
    if (ext === 'txt' || ext === 'md') return 'text';

    const m = String(mimetype || '').toLowerCase();
    if (m.includes('spreadsheet') || m.includes('excel')) return 'excel';
    if (m.includes('csv')) return 'csv';
    if (m.includes('json')) return 'json';
    if (m.includes('plain') || m.includes('text/')) return 'text';

    // Sniff by leading char
    const first = String(sample || '').trim().slice(0, 1);
    if (first === '[' || first === '{') return 'json';

    return 'text';
}

function parseBuffer(buffer, opts = {}) {
    const filename = opts.filename || '';
    const mimetype = opts.mimetype || '';
    const explicit = (opts.format || '').toLowerCase();

    if (explicit === 'excel' || /\.(xlsx|xls)$/i.test(filename)) {
        return { format: 'excel', items: parseFromExcelBuffer(buffer) };
    }

    // Everything else is text-based — decode UTF-8 first
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    const fmt = explicit || detectFormat({ filename, mimetype, sample: text.slice(0, 32) });

    let items = [];
    switch (fmt) {
        case 'json':  items = parseFromJson(text);  break;
        case 'jsonl': items = parseFromJsonl(text); break;
        case 'csv':   items = parseFromCsv(text);   break;
        default:      items = parseFromText(text);  break;
    }
    return { format: fmt, items };
}

module.exports = {
    detectFormat,
    parseBuffer,
    parseFromText,
    parseFromJson,
    parseFromJsonl,
    parseFromCsv,
    parseFromExcelBuffer,
    SUPPORTED_EXTENSIONS: ['csv', 'json', 'jsonl', 'ndjson', 'txt', 'md']
};
