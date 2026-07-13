document.addEventListener('DOMContentLoaded', () => {
    // Current Active Tab
    let activeTab = 'accounts';

    // Elements
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const tabTitle = document.getElementById('tab-title');
    const btnRefreshData = document.getElementById('btn-refresh-data');

    // Tab Switching Logic
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            
            navButtons.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`tab-${target}`).classList.add('active');
            activeTab = target;

            // Update Header Title
            tabTitle.textContent = btn.textContent.trim();

            // Load tab specific data
            loadTabContent(target);
        });
    });

    function loadTabContent(tab) {
        if (tab === 'accounts') {
            loadAccounts();
            loadKeepAlive();
        } else if (tab === 'flow') {
            // Flow is mostly user actions
        } else if (tab === 'tts') {
            loadTtsOptions();
            loadTtsHistory();
        } else if (tab === 'traffic') {
            loadTrafficLogs();
        }
    }

    // Refresh Data button
    btnRefreshData.addEventListener('click', () => {
        loadTabContent(activeTab);
    });

    // ==========================================
    // SUB-TABS (Browser Login / Paste Cookies)
    // ==========================================
    const subTabBtns = document.querySelectorAll('.sub-tab-btn');
    const subTabContents = document.querySelectorAll('.sub-tab-content');

    subTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.subtab;
            subTabBtns.forEach(b => b.classList.remove('active'));
            subTabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const targetEl = document.getElementById(target);
            if (targetEl) {
                targetEl.classList.add('active');
            }
        });
    });

    // ==========================================
    // GOOGLE ACCOUNTS SECTION
    // ==========================================
    const accountsList = document.getElementById('accounts-list');
    const btnRefreshAll = document.getElementById('btn-refresh-all');
    const btnStartLogin = document.getElementById('btn-start-login');
    const btnSaveCookies = document.getElementById('btn-save-cookies');
    const loginStatusBox = document.getElementById('login-status-box');
    const loginStatusText = document.getElementById('login-status-text');
    const cookieInput = document.getElementById('cookie-input');
    const keepaliveInterval = document.getElementById('keepalive-interval');
    const btnSaveKeepalive = document.getElementById('btn-save-keepalive');
    const keepaliveStatusText = document.getElementById('keepalive-status-text');

    async function loadAccounts() {
        accountsList.innerHTML = '<div class="loading">Loading accounts...</div>';
        try {
            const res = await fetch('/api/accounts');
            const data = await res.json();
            if (data.success && data.accounts.length > 0) {
                accountsList.innerHTML = '';
                data.accounts.forEach(acc => {
                    const card = document.createElement('div');
                    card.className = `account-card ${acc.isActive ? 'active-border' : ''}`;
                    
                    const statusClass = acc.status === 'valid' ? 'badge-valid' : 'badge-expired';
                    const activeBadge = acc.isActive ? '<span class="badge badge-active">Active</span>' : '';
                    
                    let g1Badge = '';
                    if (acc.googleOneTier && acc.googleOneTier !== 'Free (15 GB)' && acc.googleOneTier !== 'Unknown (Expired)') {
                        g1Badge = `<span class="badge badge-g1">${acc.googleOneTier}</span>`;
                    }

                    const hasGoogleOne = acc.googleOneTier && acc.googleOneTier !== 'Free (15 GB)' && acc.googleOneTier !== 'Unknown (Expired)';
                    const defaultAvatar = 'https://www.gstatic.com/images/branding/product/2x/avatar_anonymous_512dp.png';

                    card.innerHTML = `
                        <div class="account-profile-section">
                            <div class="profile-avatar-container ${hasGoogleOne ? 'google-one-ring' : ''}">
                                <img src="${acc.profilePicUrl || defaultAvatar}" class="profile-pic" referrerpolicy="no-referrer" />
                            </div>
                            <div class="account-info">
                                <div class="account-title-row">
                                    <span class="account-label">${acc.label || acc.email || 'Google Account'}</span>
                                    <span class="badge ${statusClass}">${acc.status}</span>
                                    ${g1Badge}
                                    ${activeBadge}
                                </div>
                                <span class="account-sub">${acc.email || 'no email'} · PID: ${acc.projectId ? acc.projectId.slice(0, 8) + '...' : 'none'}</span>
                            </div>
                        </div>
                        <div class="account-actions">
                            <button class="btn btn-secondary btn-sm" onclick="setupAiStudio('${acc.id}')">Setup AI Studio</button>
                            <button class="btn btn-secondary btn-sm" onclick="checkHealth('${acc.id}')">Check</button>
                            <button class="btn btn-secondary btn-sm" onclick="refreshCookies('${acc.id}')">Refresh</button>
                            ${!acc.isActive ? `<button class="btn btn-primary btn-sm" onclick="activateAccount('${acc.id}')">Activate</button>` : ''}
                            <button class="btn btn-danger btn-sm" onclick="deleteAccount('${acc.id}')">Delete</button>
                        </div>
                    `;
                    accountsList.appendChild(card);
                });
            } else {
                accountsList.innerHTML = '<p class="empty-msg">No accounts in the pool yet. Add one below!</p>';
            }
        } catch (e) {
            accountsList.innerHTML = `<div class="status-box error">Error loading accounts: ${e.message}</div>`;
        }
    }

    // Expose actions to window so onclick works
    window.activateAccount = async (id) => {
        try {
            await fetch(`/api/accounts/${id}/activate`, { method: 'POST' });
            loadAccounts();
        } catch (e) {
            alert('Failed to activate: ' + e.message);
        }
    };

    window.refreshCookies = async (id) => {
        try {
            const res = await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Cookies refreshed successfully');
                loadAccounts();
            } else {
                alert('Refresh failed: ' + data.error);
            }
        } catch (e) {
            alert('Failed to refresh: ' + e.message);
        }
    };

    window.checkHealth = async (id) => {
        try {
            const res = await fetch(`/api/accounts/${id}/health`, { method: 'POST' });
            const data = await res.json();
            alert(`Health Check: status is ${data.status}`);
            loadAccounts();
        } catch (e) {
            alert('Health check failed: ' + e.message);
        }
    };

    window.setupAiStudio = async (id) => {
        try {
            const res = await fetch(`/api/accounts/${id}/setup-aistudio`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Chrome opened successfully. Please complete the setup in the opened browser window.');
            } else {
                alert('Setup failed: ' + data.error);
            }
        } catch (e) {
            alert('Setup failed: ' + e.message);
        }
    };

    window.deleteAccount = async (id) => {
        if (!confirm('Are you sure you want to delete this account?')) return;
        try {
            await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
            loadAccounts();
        } catch (e) {
            alert('Failed to delete: ' + e.message);
        }
    };

    // Refresh all accounts
    if (btnRefreshAll) {
        btnRefreshAll.addEventListener('click', async () => {
            btnRefreshAll.disabled = true;
            btnRefreshAll.textContent = 'Refreshing...';
            try {
                const res = await fetch('/api/accounts/refresh-all', { method: 'POST' });
                const data = await res.json();
                alert(`Refreshed ${data.count} accounts.`);
                loadAccounts();
            } catch (e) {
                alert('Failed to refresh all: ' + e.message);
            } finally {
                btnRefreshAll.disabled = false;
                btnRefreshAll.textContent = 'Refresh All Active';
            }
        });
    }

    // Save cookies
    btnSaveCookies.addEventListener('click', async () => {
        const cookies = cookieInput.value.trim();
        if (!cookies) {
            alert('Please paste some cookies first');
            return;
        }
        btnSaveCookies.disabled = true;
        try {
            const res = await fetch('/api/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies })
            });
            const data = await res.json();
            if (data.success) {
                alert('Account added successfully');
                cookieInput.value = '';
                loadAccounts();
            } else {
                alert('Failed: ' + data.error);
            }
        } catch (e) {
            alert('Error: ' + e.message);
        } finally {
            btnSaveCookies.disabled = false;
        }
    });

    // Start browser login
    let loginPollInterval = null;
    btnStartLogin.addEventListener('click', async () => {
        btnStartLogin.disabled = true;
        loginStatusBox.classList.remove('hidden', 'success', 'error');
        loginStatusText.textContent = 'Membuka Chrome...';

        try {
            const res = await fetch('/api/accounts/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: '' })
            });
            const data = await res.json();
            if (data.success) {
                // Start polling
                pollLoginStatus();
            } else {
                showLoginError(data.error);
            }
        } catch (e) {
            showLoginError(e.message);
        }
    });

    function pollLoginStatus() {
        if (loginPollInterval) clearInterval(loginPollInterval);
        loginPollInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/accounts/login/status');
                const data = await res.json();
                if (data.status === 'running') {
                    loginStatusText.textContent = 'Silakan login di browser Chrome yang terbuka...';
                } else if (data.status === 'completed') {
                    clearInterval(loginPollInterval);
                    loginStatusBox.classList.add('success');
                    loginStatusText.textContent = 'Login berhasil! Akun ditambahkan.';
                    btnStartLogin.disabled = false;
                    loadAccounts();
                    
                    // Hide the success box after 5 seconds
                    setTimeout(() => {
                        loginStatusBox.classList.add('hidden');
                        loginStatusBox.classList.remove('success');
                    }, 5000);
                } else if (data.status === 'failed') {
                    clearInterval(loginPollInterval);
                    showLoginError(data.error);
                }
            } catch (e) {
                clearInterval(loginPollInterval);
                showLoginError(e.message);
            }
        }, 2000);
    }

    function showLoginError(msg) {
        loginStatusBox.classList.add('error');
        loginStatusText.textContent = 'Login gagal: ' + msg;
        btnStartLogin.disabled = false;

        // Hide the error box after 5 seconds
        setTimeout(() => {
            loginStatusBox.classList.add('hidden');
            loginStatusBox.classList.remove('error');
        }, 5000);
    }

    // Keepalive Config
    async function loadKeepAlive() {
        try {
            const res = await fetch('/api/accounts/keepalive');
            const data = await res.json();
            if (data.success) {
                keepaliveInterval.value = data.intervalMinutes;
                keepaliveStatusText.textContent = data.running ? 'Keep-alive Active' : 'Keep-alive Inactive';
            }
        } catch (e) {}
    }

    btnSaveKeepalive.addEventListener('click', async () => {
        const intervalMinutes = keepaliveInterval.value;
        try {
            const res = await fetch('/api/accounts/keepalive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ intervalMinutes })
            });
            const data = await res.json();
            if (data.success) {
                alert('Keep-alive settings saved');
                loadKeepAlive();
            } else {
                alert('Failed to save keepalive: ' + data.error);
            }
        } catch (e) {
            alert('Error: ' + e.message);
        }
    });

    // ==========================================
    // FLOW GENERATOR SECTION
    // ==========================================
    const flowPrompt = document.getElementById('flow-prompt');
    const flowModel = document.getElementById('flow-model');
    const flowAspect = document.getElementById('flow-aspect');
    const btnFlowGenerate = document.getElementById('btn-flow-generate');
    const btnFlowGenerateVideo = document.getElementById('btn-flow-generate-video');
    const flowGallery = document.getElementById('flow-gallery');

    btnFlowGenerate.addEventListener('click', () => triggerFlowGen(false));
    btnFlowGenerateVideo.addEventListener('click', () => triggerFlowGen(true));

    async function triggerFlowGen(isVideo) {
        const prompt = flowPrompt.value.trim();
        if (!prompt) return alert('Please enter a prompt first');

        const btn = isVideo ? btnFlowGenerateVideo : btnFlowGenerate;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Generating...';

        const endpoint = isVideo ? '/api/flow/generate-video' : '/api/flow/generate';

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    aspectRatio: flowAspect.value === '1:1' ? 'IMAGE_ASPECT_RATIO_SQUARE' : (flowAspect.value === '9:16' ? 'IMAGE_ASPECT_RATIO_PORTRAIT' : 'IMAGE_ASPECT_RATIO_LANDSCAPE'),
                    model: flowModel.value
                })
            });
            const data = await res.json();
            if (data.success && data.data && data.data.length > 0) {
                alert('Generation successful!');
                addToGallery(data.data, isVideo);
            } else {
                alert('Generation failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Error during generation: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    function addToGallery(items, isVideo) {
        const emptyMsg = flowGallery.querySelector('.empty-msg');
        if (emptyMsg) emptyMsg.remove();

        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'gallery-item';
            
            const fileUrl = `/output/${item.filename}`;
            if (isVideo) {
                div.innerHTML = `
                    <video src="${fileUrl}" muted loop></video>
                    <span class="gallery-item-badge">Video</span>
                `;
            } else {
                div.innerHTML = `
                    <img src="${fileUrl}" alt="Generated">
                    <span class="gallery-item-badge">Image</span>
                `;
            }

            // Click to open lightbox
            div.addEventListener('click', () => openLightbox(fileUrl, isVideo));
            flowGallery.insertBefore(div, flowGallery.firstChild);
        });
    }

    // Lightbox Modal
    const mediaModal = document.getElementById('media-modal');
    const modalMediaContainer = document.getElementById('modal-media-container');
    const closeModal = document.querySelector('.close-modal');

    function openLightbox(url, isVideo) {
        modalMediaContainer.innerHTML = '';
        if (isVideo) {
            modalMediaContainer.innerHTML = `<video src="${url}" controls autoplay loop></video>`;
        } else {
            modalMediaContainer.innerHTML = `<img src="${url}">`;
        }
        mediaModal.style.display = 'block';
    }

    closeModal.addEventListener('click', () => {
        mediaModal.style.display = 'none';
        modalMediaContainer.innerHTML = '';
    });

    window.addEventListener('click', (e) => {
        if (e.target === mediaModal) {
            mediaModal.style.display = 'none';
            modalMediaContainer.innerHTML = '';
        }
    });

    // ==========================================
    // AI STUDIO TTS SECTION
    // ==========================================
    const ttsText = document.getElementById('tts-text');
    const ttsVoice = document.getElementById('tts-voice');
    const ttsStyle = document.getElementById('tts-style');
    const ttsPace = document.getElementById('tts-pace');
    const ttsAccent = document.getElementById('tts-accent');
    const ttsScene = document.getElementById('tts-scene');
    const ttsContext = document.getElementById('tts-context');
    const btnTtsGenerate = document.getElementById('btn-tts-generate');
    const btnTtsPreview = document.getElementById('btn-tts-preview');
    const ttsAudioList = document.getElementById('tts-audio-list');

    async function loadTtsOptions() {
        try {
            const res = await fetch('/api/tts/options');
            const data = await res.json();
            
            // Populate select options
            populateSelect(ttsVoice, data.voices);
            populateSelect(ttsStyle, data.styles.map(s => s.label));
            populateSelect(ttsPace, data.paces.map(p => p.label));
            populateSelect(ttsAccent, data.accents.map(a => a.label));

            // Default values
            ttsScene.placeholder = data.defaults.scene;
            ttsContext.placeholder = data.defaults.sampleContext;
        } catch (e) {
            console.error('Failed to load TTS options', e);
        }
    }

    function populateSelect(selectEl, items) {
        selectEl.innerHTML = '';
        items.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            opt.textContent = item;
            selectEl.appendChild(opt);
        });
    }

    async function loadTtsHistory() {
        ttsAudioList.innerHTML = '<div class="loading">Loading audio history...</div>';
        try {
            const res = await fetch('/api/tts/history');
            const data = await res.json();
            if (data.items && data.items.length > 0) {
                ttsAudioList.innerHTML = '';
                data.items.forEach(item => {
                    addAudioCard(item);
                });
            } else {
                ttsAudioList.innerHTML = '<p class="empty-msg">No audio generated yet.</p>';
            }
        } catch (e) {
            ttsAudioList.innerHTML = '<p class="empty-msg">Error loading history.</p>';
        }
    }

    function addAudioCard(item) {
        const card = document.createElement('div');
        card.className = 'audio-card';
        const fileUrl = item.url.startsWith('/api') ? item.url : `/audio/${item.file}`;
        card.innerHTML = `
            <div class="audio-card-header">
                <div class="audio-card-meta">
                    <strong>Voice:</strong> ${item.voice || 'default'} · <strong>Size:</strong> ${(item.size / 1024).toFixed(1)} KB · <strong>Date:</strong> ${new Date(item.ts).toLocaleTimeString()}
                </div>
                <button class="btn btn-danger btn-sm" onclick="deleteAudio('${item.id}')">Delete</button>
            </div>
            <div class="audio-card-text" title="${item.text}">${item.text}</div>
            <div class="audio-card-player">
                <audio src="${fileUrl}" controls></audio>
            </div>
        `;
        ttsAudioList.appendChild(card);
    }

    window.deleteAudio = async (id) => {
        try {
            await fetch(`/api/tts/history/${id}`, { method: 'DELETE' });
            loadTtsHistory();
        } catch (e) {
            alert('Failed to delete audio: ' + e.message);
        }
    };

    btnTtsGenerate.addEventListener('click', () => triggerTtsGen(false));
    btnTtsPreview.addEventListener('click', () => triggerTtsGen(true));

    async function triggerTtsGen(isPreview) {
        const text = ttsText.value.trim();
        if (!text) return alert('Please enter script text first');

        const btn = isPreview ? btnTtsPreview : btnTtsGenerate;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = isPreview ? 'Generating Preview...' : 'Generating Speech...';

        const endpoint = isPreview ? '/api/tts/preview-voice' : '/api/tts/generate';

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    voice: ttsVoice.value,
                    style: ttsStyle.value,
                    pace: ttsPace.value,
                    accent: ttsAccent.value,
                    scene: ttsScene.value || ttsScene.placeholder,
                    sampleContext: ttsContext.value || ttsContext.placeholder
                })
            });
            const data = await res.json();
            if (data.file) {
                alert('Speech generated successfully!');
                loadTtsHistory();
            } else {
                alert('Generation failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Error during generation: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    // ==========================================
    // TRAFFIC LOGS SECTION
    // ==========================================
    const trafficBody = document.getElementById('traffic-body');

    async function loadTrafficLogs() {
        try {
            const res = await fetch('/api/traffic');
            const data = await res.json();
            if (data.success && data.logs.length > 0) {
                trafficBody.innerHTML = '';
                data.logs.forEach(log => {
                    const tr = document.createElement('tr');
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    const statusClass = log.status >= 200 && log.status < 300 ? 'success' : 'error';
                    tr.innerHTML = `
                        <td>${time}</td>
                        <td><strong>${log.method}</strong></td>
                        <td><code>${log.url}</code></td>
                        <td><span class="status-badge ${statusClass}">${log.status}</span></td>
                        <td>${log.durationMs}ms</td>
                    `;
                    trafficBody.appendChild(tr);
                });
            } else {
                trafficBody.innerHTML = '<tr><td colspan="5" class="text-center">No traffic recorded yet.</td></tr>';
            }
        } catch (e) {}
    }

    // ==========================================
    // INITIALIZATION & UPTIME
    // ==========================================
    loadTabContent('accounts');

    // Uptime counter
    let startTime = Date.now();
    setInterval(() => {
        const diff = Date.now() - startTime;
        const secs = Math.floor(diff / 1000) % 60;
        const mins = Math.floor(diff / 60000) % 60;
        const hours = Math.floor(diff / 3600000);
        document.getElementById('uptime-val').textContent = 
            `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }, 1000);
});
