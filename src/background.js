// ==========================================
// 🚀 INITIALIZATION & SETUP
// ==========================================
chrome.runtime.onInstalled.addListener(async () => {
    console.log("Glassbox Insight Installed. Initializing Engine...");

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
        
        // 4. Trigger an immediate sync right after installation
        await syncConfig();
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

// ==========================================
// ⏱️ THE STOPWATCH & HIT TRACKER
// ==========================================

// Helper 1: Extract domain for ROI Time Tracking
function extractDomain(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        if (!urlObj.protocol.startsWith('http')) return null;
        return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
        return null;
    }
}

// Helper 2: URL Normalizer for Audit Hit Tracking (Strips Query Params)
function normalizeUrl(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        if (!urlObj.protocol.startsWith('http')) return null;
        
        const domain = urlObj.hostname.replace(/^www\./, '');
        let path = urlObj.pathname;
        if (path === '/') path = ''; // Clean up root paths
        
        return domain + path;
    } catch (e) {
        return null;
    }
}

// Records an exact URL visit (Bypasses 5-minute rule)
async function recordUrlHit(urlStr) {
    const normalized = normalizeUrl(urlStr);
    if (!normalized) return;

    const data = await chrome.storage.local.get(['hitLogs']);
    let hitLogs = data.hitLogs || {};

    hitLogs[normalized] = (hitLogs[normalized] || 0) + 1;
    await chrome.storage.local.set({ hitLogs });
}

// Closes previous timer and starts a new one
async function updateActiveSession(newUrl, isIdleOrInactive) {
    const data = await chrome.storage.local.get(['activeSession', 'timeLogs']);
    let timeLogs = data.timeLogs || {};
    let activeSession = data.activeSession || null;

    const now = Date.now();

    // 1. Close out the previous session if one exists
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
        } else {
            activeSession = null;
        }
    }

    await chrome.storage.local.set({ activeSession, timeLogs });
}

// ==========================================
// 🎧 BROWSER EVENT LISTENERS
// ==========================================

const DEBUG_MODE = true; // Toggle to false for production
const tabUrlCache = {};

function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        if (data) {
            console.log(`[DEBUG] ${message}`, data);
        } else {
            console.log(`[DEBUG] ${message}`);
        }
    }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab || !tab.url) return;

    debugLog("Tab Activated. Raw Tab Object:", tab);

    // 🎯 FIX: Edge Case Catch. If tab updated in the background and we missed the event,
    // catch the new hit the moment the user actually switches to look at the tab!
    if (tab.url !== tabUrlCache[activeInfo.tabId]) {
        tabUrlCache[activeInfo.tabId] = tab.url;
        await recordUrlHit(tab.url);
    }

    await updateActiveSession(tab.url, false);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Ignore if Chrome hasn't attached a URL to the tab object yet
    if (!tab.url) return;

    debugLog(`Tab ${tabId} Updated. changeInfo:`, changeInfo);
    
    // 🎯 FIX: The "Infinite Loading Game" Bug
    // Heavy games like Eaglercraft open WebSockets or lock the main thread, 
    // preventing the DOM from ever reaching changeInfo.status === 'complete'.
    // Instead of waiting for 'complete', we now track hits purely by comparing 
    // the tab's current absolute URL against our internal cache.
    if (tab.url !== tabUrlCache[tabId]) {
        debugLog(`🎯 HIT RECORDED! Domain: ${tab.url}`);
        tabUrlCache[tabId] = tab.url; 
        
        await recordUrlHit(tab.url);
        
        if (tab.active) {
            await updateActiveSession(tab.url, false);
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    debugLog(`Tab ${tabId} closed. Clearing cache.`);
    delete tabUrlCache[tabId];
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        await updateActiveSession(null, true);
    } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }
    }
});

chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState === 'idle' || newState === 'locked') {
        await updateActiveSession(null, true);
    } else if (newState === 'active') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }
    }
});

// ==========================================
// ☁️ CLOUDFLARE SYNC & INGEST ENGINE
// ==========================================

async function syncConfig() {
    console.log("🔄 Fetching Insight Settings from Cloudflare...");
    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        const response = await fetch(`${baseUrl}/api/insight/sync`);
        if (!response.ok) throw new Error("Sync failed");
        
        const data = await response.json();
        
        await chrome.storage.local.set({
            approvedApps: data.approvedApps,
            systemConfig: data.config
        });
        
        console.log("✅ Config Synced!");
    } catch (err) {
        console.error("❌ Sync Error:", err);
    }
}

async function uploadLogs() {
    console.log("📤 Preparing to batch upload time & hit logs...");
    try {
        // Force the stopwatch to close out the current session
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }

        const data = await chrome.storage.local.get(['studentHash', 'timeLogs', 'hitLogs', 'approvedApps', 'systemConfig']);
        
        const timeLogs = data.timeLogs || {};
        const hitLogs = data.hitLogs || {};
        const approvedSet = new Set(data.approvedApps || []);
        const threshold = parseFloat(data.systemConfig?.insight_unapproved_threshold_minutes || "5");

        const masterLogs = [];

        // 1. Process Time Logs (Filtered by threshold rule)
        for (const [domain, minutes] of Object.entries(timeLogs)) {
            if (approvedSet.has(domain) || minutes >= threshold) {
                masterLogs.push({ type: "time", target: domain, value: minutes });
            }
        }

        // 2. Process Hit Logs (Exact URLs, NO time threshold!)
        for (const [url, hits] of Object.entries(hitLogs)) {
            masterLogs.push({ type: "hit", target: url, value: hits });
        }

        if (masterLogs.length === 0) {
            console.log("No significant logs to upload this hour.");
            return;
        }

        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        // 3. CHUNKING LOGIC: Stay under Cloudflare's 250 writeDataPoint limit
        const MAX_PAYLOAD_SIZE = 200; 
        let allChunksSuccessful = true;

        for (let i = 0; i < masterLogs.length; i += MAX_PAYLOAD_SIZE) {
            const chunk = masterLogs.slice(i, i + MAX_PAYLOAD_SIZE);

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
                allChunksSuccessful = false;
                break; // Stop uploading, keep remaining data for next hour
            }
        }

        if (allChunksSuccessful) {
            // CRITICAL: Only wipe local logs if EVERY chunk uploaded successfully
            await chrome.storage.local.set({ timeLogs: {}, hitLogs: {} });
            console.log(`✅ Uploaded ${masterLogs.length} total data points across chunks!`);
        }

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