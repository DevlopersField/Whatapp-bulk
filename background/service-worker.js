import { QueueManager } from '../core/queue-manager.js';

/**
 * Central event router for the extension. Owns side panel behavior,
 * the dispatch loop that drives the WhatsApp content script through the
 * task queue, and the rate-limiting / anti-detection guardrails.
 */

const queueManager = new QueueManager();
const WHATSAPP_URL_PATTERN = 'https://web.whatsapp.com/*';
const RECOVERY_ALARM = 'outreach-recovery-tick';
const STALL_THRESHOLD_MS = 45_000; // heartbeat older than this = abandoned task
// URL-fetched media is never stored — it's fetched fresh from the network
// each time it's actually about to be sent, so it isn't bound by
// chrome.storage.session's 10MB quota the way an uploaded file is. This
// keeps a high but sane ceiling for real HD/large video pulled from a link.
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
// Uploaded files DO get stashed in chrome.storage.session (hard-capped at
// 10MB, base64 inflates ~1.33x) so this stays well under that regardless of
// what the side panel already gates client-side — defense in depth.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const UPLOADED_MEDIA_KEY = 'outreach_uploaded_media';

let dispatchTimer = null;
let activeTabId = null;
let cachedConnection = { connected: false };

// chrome.storage.session defaults to TRUSTED_CONTEXTS (background) only —
// the content script's pending-task stash (see content-script.js) needs
// to read/write it too, across the WhatsApp reload. This has to be set
// every time the service worker spins up; it does not persist on its own.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((err) => console.error('[ServiceWorker] setAccessLevel failed:', err));

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[ServiceWorker] Installed. Reason: ${details.reason}`);
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
});

// Open the side panel when the toolbar action icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[ServiceWorker] setPanelBehavior failed:', err));

// --- Messaging protocol ----------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'ENGINE_START':
      startDispatchLoop();
      return false;
    case 'ENGINE_PAUSE':
      stopDispatchLoop();
      return false;
    case 'ENGINE_CLEAR':
      stopDispatchLoop();
      return false;
    case 'CONNECTION_STATUS':
      if (sender.tab?.id) activeTabId = sender.tab.id;
      cachedConnection = message.payload;
      broadcast({ type: 'CONNECTION_STATUS', payload: message.payload });
      return false;
    case 'GET_CONNECTION_STATUS':
      checkConnectionStatus().then(sendResponse);
      return true; // async sendResponse
    case 'SEND_TEST':
      sendTestMessage(message.payload).then(sendResponse);
      return true; // async sendResponse
    case 'FETCH_MEDIA_BLOB':
      fetchMediaBlob(message.payload.mediaUrl)
        .then((blob) => sendResponse({ blob }))
        .catch((error) => sendResponse({ error: error.message }));
      return true; // async sendResponse
    case 'STORE_UPLOADED_MEDIA':
      storeUploadedMedia(message.payload)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true; // async sendResponse
    case 'FETCH_UPLOADED_MEDIA':
      fetchUploadedMediaBlob()
        .then((blob) => sendResponse({ blob }))
        .catch((error) => sendResponse({ error: error.message }));
      return true; // async sendResponse
    case 'TASK_RESULT':
      handleTaskResult(message.payload);
      return false;
    default:
      return false;
  }
});

// --- Deep-link reload handoff -----------------------------------------

// taskId -> { resolve, timer }, populated by waitForTaskResult while a
// content-script reload is in flight for that task.
const pendingTaskResults = new Map();

function waitForTaskResult(taskId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTaskResults.delete(taskId);
      resolve({ success: false, error: 'Timed out waiting for chat page to reload.' });
    }, timeoutMs);

    pendingTaskResults.set(taskId, { resolve, timer });
  });
}

function handleTaskResult(payload) {
  const waiter = pendingTaskResults.get(payload?.taskId);
  if (!waiter) return; // no one waiting (timed out already, or stray message)
  clearTimeout(waiter.timer);
  pendingTaskResults.delete(payload.taskId);
  waiter.resolve(payload);
}

/**
 * Actively re-checks the WhatsApp tab's session state rather than waiting
 * on the content script's own announce, so the side panel gets a fresh
 * answer every time it opens (not just whatever fired once at page load).
 *
 * A tab opened before the extension was (re)loaded has no content script
 * injected into it yet — chrome.tabs.sendMessage fails with "Receiving end
 * does not exist" in that case. Rather than surface that as a permanent
 * Disconnected state, re-inject the content script once and retry.
 */
async function checkConnectionStatus() {
  const tabId = await findExistingWhatsAppTab();
  if (!tabId) {
    cachedConnection = { connected: false, reason: 'no-tab' };
    return cachedConnection;
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_SESSION' });
    cachedConnection = result ?? { connected: false };
    return cachedConnection;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
      const retryResult = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_SESSION' });
      cachedConnection = retryResult ?? { connected: false };
      return cachedConnection;
    } catch (injectError) {
      cachedConnection = { connected: false, reason: 'no-content-script' };
      return cachedConnection;
    }
  }
}

/**
 * One-off send outside the queue — bypasses rate limiting/hourly cap on
 * purpose since it's a manual, single, user-triggered action for verifying
 * the template/media works before committing to a full batch.
 */
async function sendTestMessage({ phone, messagePayload, mediaUrl, mediaType, useUploadedMedia, sendAsDocument }) {
  if (!phone) {
    return { success: false, error: 'No test phone number provided.' };
  }
  try {
    const tabId = await getTargetTabId();
    const result = await sendExecuteTask(tabId, {
      id: `test_${Date.now()}`,
      recipient: { phone },
      messagePayload,
      mediaUrl,
      mediaType,
      useUploadedMedia,
      sendAsDocument,
    });
    log(
      result?.success
        ? `Test message sent to ${phone}.`
        : `Test message failed for ${phone}: ${result?.error || 'unknown error'}`
    );
    return result;
  } catch (error) {
    log(`Test message failed for ${phone}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Safety-net: chrome.alarms has a 1-minute floor, so it can't drive the
// 15-45s per-message cadence directly, but it recovers a dispatch loop
// that got dropped when the service worker was suspended mid-cycle.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RECOVERY_ALARM) return;

  const { state } = await queueManager.getSnapshot();
  if (!state || state.status !== 'RUNNING') return;

  const stalled = Date.now() - (state.lastHeartbeat || 0) > STALL_THRESHOLD_MS;
  if (stalled && dispatchTimer === null) {
    log('Recovering stalled dispatch loop after service worker suspension.');
    runDispatchCycle();
  }
});

// --- Dispatch loop -----------------------------------------------------

function startDispatchLoop() {
  if (dispatchTimer !== null) return; // already running
  runDispatchCycle();
}

function stopDispatchLoop() {
  if (dispatchTimer !== null) {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
  }
}

async function runDispatchCycle() {
  dispatchTimer = null;

  const { state, config } = await queueManager.getSnapshot();
  if (!state || state.status !== 'RUNNING') return;

  const capCheck = await checkHourlyCap(state, config);
  if (capCheck.blocked) {
    log(`Hourly batch cap (${config.hourlyBatchCap}) reached. Cooling down.`);
    dispatchTimer = setTimeout(runDispatchCycle, capCheck.waitMs);
    return;
  }

  const task = await queueManager.acquireNextTask();
  if (!task) {
    log('Queue complete.');
    await broadcastSnapshot();
    return;
  }

  await broadcastSnapshot();

  try {
    const tabId = await getTargetTabId();
    const result = await sendExecuteTask(tabId, task);

    if (result?.success) {
      await queueManager.recordTaskOutcome(task.id, true);
      log(`Sent to ${task.recipient.phone}.`);
    } else {
      await queueManager.recordTaskOutcome(task.id, false, result?.error || 'Unknown error');
      log(`Failed for ${task.recipient.phone}: ${result?.error || 'unknown error'}`);
    }
  } catch (error) {
    await queueManager.recordTaskOutcome(task.id, false, error.message);
    log(`Failed for ${task.recipient.phone}: ${error.message}`);
  }

  await incrementWindowCount();
  await broadcastSnapshot();

  const { state: freshState } = await queueManager.getSnapshot();
  if (freshState?.status === 'RUNNING') {
    const delayMs = computeNextDelayMs(config);
    dispatchTimer = setTimeout(runDispatchCycle, delayMs);
  }
}

// --- Rate limiting / anti-detection ---------------------------------------

function computeNextDelayMs(config) {
  const minMs = (config?.minDelaySeconds ?? 15) * 1000;
  const maxMs = (config?.maxDelaySeconds ?? 45) * 1000;
  const jitterPercent = config?.jitterPercent ?? 20;

  const base = minMs + Math.random() * (maxMs - minMs);
  const jitterRange = base * (jitterPercent / 100);
  const jittered = base + (Math.random() * 2 - 1) * jitterRange;

  return Math.max(minMs, Math.round(jittered));
}

async function checkHourlyCap(state, config) {
  const cap = config?.hourlyBatchCap ?? 25;
  const windowMs = 3_600_000;
  const now = Date.now();
  const windowStart = state.windowStart ?? now;

  if (now - windowStart >= windowMs) {
    state.windowStart = now;
    state.windowCount = 0;
    await chrome.storage.local.set({ [queueManager.STATE_KEY]: state });
    return { blocked: false };
  }

  if ((state.windowCount ?? 0) >= cap) {
    return { blocked: true, waitMs: windowStart + windowMs - now };
  }

  return { blocked: false };
}

async function incrementWindowCount() {
  const { state } = await queueManager.getSnapshot();
  if (!state) return;
  state.windowCount = (state.windowCount ?? 0) + 1;
  await chrome.storage.local.set({ [queueManager.STATE_KEY]: state });
}

// --- Tab / content script bridging -----------------------------------------

async function findExistingWhatsAppTab() {
  if (activeTabId) {
    try {
      await chrome.tabs.get(activeTabId);
      return activeTabId;
    } catch (e) {
      activeTabId = null;
    }
  }

  const tabs = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  if (tabs.length > 0) {
    activeTabId = tabs[0].id;
    return activeTabId;
  }

  return null;
}

async function getTargetTabId() {
  const existing = await findExistingWhatsAppTab();
  if (existing) return existing;

  const created = await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  activeTabId = created.id;
  await waitForTabLoad(activeTabId);
  return activeTabId;
}

/** Waits for a tab to finish loading so its content script has had a chance to inject. */
function waitForTabLoad(tabId, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Retries tabs.sendMessage briefly — even after waitForTabLoad, there's a
 * small residual window where the tab reports "complete" but the content
 * script's document_idle listener hasn't attached yet.
 */
async function sendTabMessageWithRetry(tabId, message, attempts = 4, delayMs = 750) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

/**
 * Fetches a user-supplied media URL from the background context so
 * host_permissions (not page CORS policy) governs access — a content
 * script fetch would be blocked by whatever CORS policy the media host
 * sets. The resulting Blob is handed to the content script for the actual
 * DOM drop-to-attach sequence, since only the content script has DOM access.
 */
async function fetchMediaBlob(mediaUrl) {
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`Media fetch failed: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_MEDIA_BYTES) {
    throw new Error(`Media exceeds ${MAX_MEDIA_BYTES / (1024 * 1024)}MB limit.`);
  }
  return blob;
}

/**
 * The media Blob itself is fetched by the content script (via a
 * FETCH_MEDIA_BLOB round trip) only once it's actually ready to send —
 * not here — because a task that needs a deep-link navigation first would
 * lose an already-fetched Blob across the resulting page reload. Passing
 * just the mediaUrl keeps this payload plain-JSON and reload-safe.
 */
async function sendExecuteTask(tabId, task) {
  const payload = {
    taskId: task.id,
    recipient: task.recipient,
    messagePayload: task.messagePayload,
    mediaUrl: task.mediaUrl,
    mediaType: task.mediaType,
    useUploadedMedia: task.useUploadedMedia,
    sendAsDocument: task.sendAsDocument,
  };

  const ack = await sendTabMessageWithRetry(tabId, { type: 'EXECUTE_TASK', payload });
  if (ack?.pending) {
    return waitForTaskResult(task.id);
  }
  return ack;
}

/**
 * A locally uploaded file is stored once (base64, JSON-safe) in
 * chrome.storage.session — not chrome.storage.local — since it's only
 * needed for the lifetime of the current send job, and session storage
 * survives service worker restarts (unlike a plain module variable) without
 * writing the file to disk. Base64/JSON keeps this bulletproof across any
 * Chrome version, rather than betting on Blob support in storage APIs.
 */
async function storeUploadedMedia({ base64, mimeType, mediaType }) {
  const approxBytes = Math.ceil((base64.length * 3) / 4);
  if (approxBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`Media exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`);
  }
  await chrome.storage.session.set({ [UPLOADED_MEDIA_KEY]: { base64, mimeType, mediaType } });
}

async function fetchUploadedMediaBlob() {
  const stored = await chrome.storage.session.get(UPLOADED_MEDIA_KEY);
  const record = stored[UPLOADED_MEDIA_KEY];
  if (!record) {
    throw new Error('No uploaded media found — re-upload the file.');
  }
  return base64ToBlob(record.base64, record.mimeType);
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

// --- Status broadcast helpers -----------------------------------------

async function broadcastSnapshot() {
  const snapshot = await queueManager.getSnapshot();
  broadcast({ type: 'QUEUE_SNAPSHOT', payload: snapshot });
}

function log(message) {
  console.log(`[ServiceWorker] ${message}`);
  broadcast({ type: 'TASK_LOG', payload: { message } });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No listener currently open (side panel closed) — safe to ignore.
  });
}
