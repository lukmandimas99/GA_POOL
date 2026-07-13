const config = require('./config');

/**
 * Parse raw cookie string yang di-paste dari browser.
 * Mendukung format:
 *   - "name=value; name2=value2" (standard)
 *   - "name=value; Path=/; Expires=...; HttpOnly; Secure" (Set-Cookie format)
 *   - Multi-line paste (setiap baris diproses)
 * 
 * Returns: Map<name, value>
 */
function parseCookies(rawString) {
    if (!rawString || rawString.trim() === '') return new Map();

    const cookies = new Map();
    const cookieAttributes = new Set([
        'path', 'expires', 'max-age', 'domain', 'secure', 'httponly', 'samesite'
    ]);

    const lines = rawString.split(/\n/).map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        const parts = line.split(';').map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx === -1) continue;
            const name = part.substring(0, eqIdx).trim();
            const value = part.substring(eqIdx + 1).trim();
            if (cookieAttributes.has(name.toLowerCase())) continue;
            if (name) cookies.set(name, value);
        }
    }
    return cookies;
}

/**
 * Convert cookie Map to cookie header string
 */
function cookieMapToString(cookieMap) {
    const parts = [];
    for (const [name, value] of cookieMap) {
        parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
}

/**
 * Get Labs cookies string for Google Labs API calls.
 */
function getLabsCookies() {
    try {
        const sessionManager = require('./session-manager');
        const smCookies = sessionManager.getActiveCookies();
        if (smCookies) return smCookies;
    } catch (e) { /* Session manager not initialized yet */ }
    return '';
}

/**
 * Extract specific cookie value from raw cookie string
 */
function getCookieValue(rawString, cookieName) {
    const cookies = parseCookies(rawString);
    return cookies.get(cookieName) || null;
}

/**
 * Clean raw paste format: strip Set-Cookie attributes, keep only name=value pairs
 */
function cleanRawCookies(rawPaste) {
    const cookies = parseCookies(rawPaste);
    return cookieMapToString(cookies);
}

module.exports = {
    parseCookies,
    cookieMapToString,
    getLabsCookies,
    getCookieValue,
    cleanRawCookies
};
