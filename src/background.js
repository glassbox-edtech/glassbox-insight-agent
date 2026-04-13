// ==========================================
// 🤝 THE STARTUP HANDSHAKE
// ==========================================
async function performHandshake(studentHash) {
    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const config = await (await fetch(configUrl)).json();
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        const res = await fetch(`${baseUrl}/api/student/me?hash=${studentHash}`);
        
        if (res.status === 404) {
            console.log("⚠️ Student not registered. Opening setup page...");
            chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
            return false;
        } else if (res.ok) {
            const data = await res.json();
            await chrome.storage.local.set({ schoolId: data.schoolId });
            console.log(`✅ Student securely locked to school ID: ${data.schoolId}`);
            return true;
        }
    } catch (err) {
        console.error("Handshake failed (offline?).", err);
        return false;
    }
}

// ==========================================
// 🚀 INITIALIZATION & SETUP
// ==========================================
chrome.runtime.onInstalled.addListener(async () => {
    console.log("Glassbox Insight Installed. Initializing Engine v1.2.0...");

    // 1. Set Chrome to detect "Idle" state after 60 seconds of no mouse/keyboard input
    chrome.idle.setDetectionInterval(60);

    // 2. Create our recurring alarms
    chrome.alarms.create("syncInsightConfig", { periodInMinutes: 360 });
    chrome.alarms.create("ingestInsightLogs", { periodInMinutes: 60 });
    
    // 3. Identity Hashing Setup (Same as Filter Agent)
    try {
        const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
        const email = userInfo.email || "anonymous@student.local";
        
        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const studentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        await chrome.storage.local.set({ studentHash: studentHash });
        console.log("✅ Student ID securely hashed:", studentHash);
        
        // 4. Perform Handshake & Sync
        const isRegistered = await performHandshake(studentHash);
        if (isRegistered) {
            await syncConfig();
        }
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    console.log("🧹 Chrome started. Cleaning up ghost sessions & verifying identity...");
    await chrome.storage.local.set({ activeSession: null });
    
    const data = await chrome.storage.local.get('studentHash');
    if (data.studentHash) {
        const isRegistered = await performHandshake(data.studentHash);
        if (isRegistered) {
            await syncConfig();
        }
    }
});

// ==========================================
// 📨 MESSAGE LISTENERS
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "force_sync") {
        console.log("📥 Received force_sync command from setup page. Executing immediate sync...");
        syncConfig().then(() => {
            sendResponse({ success: true });
        });
        return true; 
    }
});

// ==========================================
// ⏱️ THE STOPWATCH & HIT TRACKER
// ==========================================

function extractDomain(urlStr) {
    try {
        const cleanUrl = urlStr.split('#')[0];
        const urlObj = new URL(cleanUrl);
        if (!urlObj.protocol.startsWith('http')) return null;
        return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
        return null;
    }
}

// 🎯 NEW: Smart URL Normalizer (Query String Allowlist)
function normalizeUrl(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        if (!urlObj.protocol.startsWith('http')) return null;
        
        const domain = urlObj.hostname.replace(/^www\./, '');
        let path = urlObj.pathname;
        
        // Preserve SPA hash routes
        if (urlObj.hash.startsWith('#/')) {
            path += urlObj.hash;
        }
        
        if (path === '/') path = ''; 
        
        // Smart Query String Allowlist
        let queryString = '';
        switch (domain) {
            case 'youtube.com':
                if (urlObj.searchParams.has('v')) {
                    queryString = `?v=${urlObj.searchParams.get('v')}`;
                }
                break;
            case 'google.com':
            case 'bing.com':
                if (urlObj.searchParams.has('q')) {
                    queryString = `?q=${urlObj.searchParams.get('q')}`;
                }
                break;
            default:
                // For docs.google.com and everything else, queryString remains empty, stripping all tokens!
                break;
        }

        return domain + path + queryString;
    } catch (e) {
        return null;
    }
}

// 🎯 UPDATED: Records URL hit and caches the Tab Title
async function recordUrlHit(urlStr, title) {
    const normalized = normalizeUrl(urlStr);
    if (!normalized) return;

    const data = await chrome.storage.local.get(['hitLogs', 'titleCache']);
    let hitLogs = data.hitLogs || {};
    let titleCache = data.titleCache || {};

    hitLogs[normalized] = (hitLogs[normalized] || 0) + 1;
    
    if (title) {
        titleCache[normalized] = title;
    }

    await chrome.storage.local.set({ hitLogs, titleCache });
}

// 🎯 UPDATED: Updates Active Session and caches Domain Title
async function updateActiveSession(newUrl, isIdleOrInactive, title) {
    const data = await chrome.storage.local.get(['activeSession', 'timeLogs', 'titleCache']);
    let timeLogs = data.timeLogs || {};
    let activeSession = data.activeSession || null;
    let titleCache = data.titleCache || {};

    const now = Date.now();

    // 1. Close out the previous session
    if (activeSession) {
        const elapsedMs = now - activeSession.startTime;
        const elapsedMins = elapsedMs / (1000 * 60);

        if (elapsedMins > 0 && elapsedMins < 240) {
            timeLogs[activeSession.domain] = (timeLogs[activeSession.domain] || 0) + elapsedMins;
        }
    }

    // 2. Start the new session
    if (isIdleOrInactive || !newUrl || newUrl.startsWith('chrome://')) {
        activeSession = null; 
    } else {
        const domain = extractDomain(newUrl);
        if (domain) {
            activeSession = { domain: domain, startTime: now };
            if (title) {
                titleCache[domain] = title; // Also save the title for the base domain
            }
        } else {
            activeSession = null;
        }
    }

    await chrome.storage.local.set({ activeSession, timeLogs, titleCache });
}

// ==========================================
// 🎧 BROWSER EVENT LISTENERS
// ==========================================

const DEBUG_MODE = true; 
const tabUrlCache = {};

function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        if (data) console.log(`[DEBUG] ${message}`, data);
        else console.log(`[DEBUG] ${message}`);
    }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab || !tab.url) return;

    debugLog("Tab Activated. Raw Tab Object:", tab);

    if (tab.url !== tabUrlCache[activeInfo.tabId]) {
        tabUrlCache[activeInfo.tabId] = tab.url;
        await recordUrlHit(tab.url, tab.title);
    }

    await updateActiveSession(tab.url, false, tab.title);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!tab.url) return;
    
    // 🎯 NEW: If the tab changes its title (e.g. Google Doc finishes loading), update our cache!
    if (changeInfo.title) {
        const normalized = normalizeUrl(tab.url);
        const domain = extractDomain(tab.url);
        const data = await chrome.storage.local.get('titleCache');
        let titleCache = data.titleCache || {};
        if (normalized) titleCache[normalized] = changeInfo.title;
        if (domain) titleCache[domain] = changeInfo.title;
        await chrome.storage.local.set({ titleCache });
    }
    
    if (tab.url !== tabUrlCache[tabId]) {
        debugLog(`🎯 HIT RECORDED! Domain: ${tab.url}`);
        tabUrlCache[tabId] = tab.url; 
        
        await recordUrlHit(tab.url, tab.title);
        
        if (tab.active) {
            await updateActiveSession(tab.url, false, tab.title);
        }
    }
});

// Comprehensive SPA and Hash Navigation Tracking
if (chrome.webNavigation) {
    const handleSpaNavigation = async (details) => {
        if (details.frameId === 0) { 
            debugLog(`🔄 SPA Navigation detected: ${details.url}`);
            
            if (details.url !== tabUrlCache[details.tabId]) {
                tabUrlCache[details.tabId] = details.url;
                
                try {
                    const tab = await chrome.tabs.get(details.tabId);
                    await recordUrlHit(details.url, tab ? tab.title : null);

                    if (tab && tab.active) {
                        await updateActiveSession(details.url, false, tab.title);
                    }
                } catch (err) {
                    await recordUrlHit(details.url, null);
                }
            }
        }
    };

    chrome.webNavigation.onHistoryStateUpdated.addListener(handleSpaNavigation);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSpaNavigation);
    
} else {
    console.warn("⚠️ webNavigation API not found. Please add 'webNavigation' to manifest.json permissions!");
}

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    debugLog(`🔄 Tab ${removedTabId} was replaced by ${addedTabId}`);
    
    if (tabUrlCache[removedTabId]) {
        tabUrlCache[addedTabId] = tabUrlCache[removedTabId];
        delete tabUrlCache[removedTabId];
    }
    
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id === addedTabId) {
        await updateActiveSession(tabs[0].url, false, tabs[0].title);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    debugLog(`Tab ${tabId} closed. Clearing cache.`);
    delete tabUrlCache[tabId];
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        await updateActiveSession(null, true, null);
    } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false, tabs[0].title);
        }
    }
});

chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState === 'idle' || newState === 'locked') {
        await updateActiveSession(null, true, null);
    } else if (newState === 'active') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false, tabs[0].title);
        }
    }
});

// ==========================================
// ☁️ CLOUDFLARE SYNC & INGEST ENGINE
// ==========================================

async function syncConfig() {
    console.log("🔄 Fetching Insight Settings from Cloudflare...");
    
    const data = await chrome.storage.local.get('schoolId');
    const schoolId = data.schoolId || 1;
    
    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        const response = await fetch(`${baseUrl}/api/insight/sync?schoolId=${schoolId}`);
        if (!response.ok) throw new Error("Sync failed");
        
        const resData = await response.json();
        
        await chrome.storage.local.set({
            approvedApps: resData.approvedApps,
            systemConfig: resData.config
        });
        
        console.log("✅ Config Synced!");
    } catch (err) {
        console.error("❌ Sync Error:", err);
    }
}

async function uploadLogs() {
    console.log("📤 Preparing to batch upload time & hit logs...");
    
    if (!navigator.onLine) {
        console.log("📶 Device is offline. Telemetry securely queued in local storage.");
        return;
    }

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false, tabs[0].title);
        }

        const data = await chrome.storage.local.get(['studentHash', 'timeLogs', 'hitLogs', 'approvedApps', 'systemConfig', 'titleCache']);
        
        const timeLogs = data.timeLogs || {};
        const hitLogs = data.hitLogs || {};
        const titleCache = data.titleCache || {};
        const approvedSet = new Set(data.approvedApps || []);
        const threshold = parseFloat(data.systemConfig?.insight_unapproved_threshold_minutes || "5");

        const masterLogs = [];

        // 1. Process Time Logs
        for (const [domain, minutes] of Object.entries(timeLogs)) {
            if (approvedSet.has(domain) || minutes >= threshold) {
                masterLogs.push({ type: "time", target: domain, value: minutes, title: titleCache[domain] || null });
            }
        }

        // 2. Process Hit Logs
        for (const [url, hits] of Object.entries(hitLogs)) {
            masterLogs.push({ type: "hit", target: url, value: hits, title: titleCache[url] || null });
        }

        if (masterLogs.length === 0) return;

        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        const MAX_PAYLOAD_SIZE = 200; 
        
        const successfullyUploadedTime = {};
        const successfullyUploadedHits = {};

        for (let i = 0; i < masterLogs.length; i += MAX_PAYLOAD_SIZE) {
            const chunk = masterLogs.slice(i, i + MAX_PAYLOAD_SIZE);

            try {
                const response = await fetch(`${baseUrl}/api/insight/ingest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        studentHash: data.studentHash,
                        logs: chunk
                    })
                });

                if (!response.ok) {
                    console.error(`❌ Chunk ${i / MAX_PAYLOAD_SIZE + 1} failed.`);
                    break; 
                }

                chunk.forEach(log => {
                    if (log.type === 'time') successfullyUploadedTime[log.target] = log.value;
                    if (log.type === 'hit') successfullyUploadedHits[log.target] = log.value;
                });

            } catch (fetchErr) {
                console.error("📶 Network error mid-upload. Queueing remaining data.", fetchErr);
                break; 
            }
        }

        const currentData = await chrome.storage.local.get(['timeLogs', 'hitLogs', 'titleCache']);
        let currentTime = currentData.timeLogs || {};
        let currentHits = currentData.hitLogs || {};
        let currentTitles = currentData.titleCache || {};

        let removedCount = 0;

        for (const [domain, minutes] of Object.entries(successfullyUploadedTime)) {
            if (currentTime[domain]) {
                currentTime[domain] -= minutes;
                if (currentTime[domain] <= 0.01) { 
                    delete currentTime[domain];
                    delete currentTitles[domain]; // 🎯 Cleanup Title Cache
                }
                removedCount++;
            }
        }
        
        for (const [url, hits] of Object.entries(successfullyUploadedHits)) {
            if (currentHits[url]) {
                currentHits[url] -= hits;
                if (currentHits[url] <= 0) {
                    delete currentHits[url];
                    delete currentTitles[url]; // 🎯 Cleanup Title Cache
                }
                removedCount++;
            }
        }

        await chrome.storage.local.set({ timeLogs: currentTime, hitLogs: currentHits, titleCache: currentTitles });
        console.log(`✅ Upload cycle complete. Safely subtracted ${removedCount} synced items.`);

    } catch (err) {
        console.error("❌ Batch Upload Error:", err);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "syncInsightConfig") {
        syncConfig();
    } else if (alarm.name === "ingestInsightLogs") {
        uploadLogs();
    }
});

// ==========================================
// 🧪 TESTING EXPORTS
// ==========================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractDomain,
        normalizeUrl,
        updateActiveSession,
        recordUrlHit
    };
}