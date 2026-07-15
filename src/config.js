require('dotenv').config();

const cfg = {
  // 2Captcha
  TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY || '',
  TWOCAPTCHA_CREATE_URL: 'https://api.2captcha.com/createTask',
  TWOCAPTCHA_RESULT_URL: 'https://api.2captcha.com/getTaskResult',

  // Google Flow
  PROJECT_ID: process.env.PROJECT_ID || '',

  // reCAPTCHA Enterprise
  RECAPTCHA_SITE_KEY: '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
  RECAPTCHA_WEBSITE_URL: 'https://labs.google',

  // API URLs
  LABS_BASE_URL: 'https://labs.google',
  SANDBOX_API_URL: 'https://aisandbox-pa.googleapis.com/v1',
  AISTUDIO_URL: 'https://aistudio.google.com/generate-speech',

  // Security
  API_SECRET_KEY: (process.env.API_SECRET_KEY || '').trim(),
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:4005,http://127.0.0.1:4005').trim(),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20', 10),
  KEEP_ALIVE_INTERVAL_MINUTES: parseInt(process.env.KEEP_ALIVE_INTERVAL_MINUTES || '30', 10),

  // Server
  PORT: process.env.PORT || 4005,
  HOST: process.env.HOST || '127.0.0.1',

  // Path to real Chrome (not Puppeteer's bundled Chromium)
  CHROME_EXECUTABLE_PATH: (() => {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return paths[0]; // fallback
  })(),

  // TTS
  TTS_HEADLESS: process.env.TTS_HEADLESS === 'true',
  TTS_KEEP_SESSION: process.env.TTS_KEEP_SESSION !== 'false',

  // Default Headers — MUST match the actual browser used by Puppeteer
  DEFAULT_HEADERS: {
    'accept': '*/*',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': '"Google Chrome";v="147", "Chromium";v="147", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  },

  CROSS_SITE_HEADERS: {
    'sec-fetch-site': 'cross-site',
    'x-browser-channel': 'stable',
    'x-browser-copyright': 'Copyright 2025 Google LLC. All Rights reserved.',
    'x-browser-validation': '',  // Will be captured dynamically from real Chrome
    'x-browser-year': '2025',
    'x-client-data': ''  // Will be captured dynamically from real Chrome
  }
};

module.exports = cfg;
