/**
 * Injected into WhatsApp Web. Ingests EXECUTE_TASK commands from the
 * background service worker and drives the platform adapter to perform
 * the actual conversation open / type / send sequence.
 *
 * Uses dynamic import() for its ES module dependencies because content
 * scripts declared via manifest.json content_scripts run as classic
 * scripts, not modules.
 *
 * Deep-linking to a chat (web.whatsapp.com/send?phone=...) triggers a full
 * page reload, which destroys this script's JS context mid-task — any
 * sendResponse queued for "after" that reload would never fire, which is
 * what caused "message channel closed" errors. So a task that needs
 * navigation gets stashed in chrome.storage.session before navigating, the
 * original message is ack'd immediately with { pending: true }, and the
 * freshly-reloaded script instance picks the stashed task back up and
 * reports the real result via a separate TASK_RESULT message.
 */

const PENDING_TASK_KEY = 'outreach_pending_task';

let adapterPromise = null;

async function getAdapter() {
  if (!adapterPromise) {
    adapterPromise = import(chrome.runtime.getURL('content/adapters/whatsapp-adapter.js')).then(
      (mod) => new mod.WhatsAppAdapter()
    );
  }
  return adapterPromise;
}

async function reportConnection(state) {
  chrome.runtime.sendMessage({
    type: 'CONNECTION_STATUS',
    payload: state,
  });
}

async function fetchMediaAsFile(mediaUrl, mediaType) {
  const response = await chrome.runtime.sendMessage({
    type: 'FETCH_MEDIA_BLOB',
    payload: { mediaUrl },
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  const ext = mediaType === 'video' ? 'mp4' : 'jpg';
  const blob = response.blob;
  return new File([blob], `attachment.${ext}`, {
    type: blob.type || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
  });
}

async function executeSend(adapter, task) {
  if (task.mediaUrl) {
    const file = await fetchMediaAsFile(task.mediaUrl, task.mediaType);
    await adapter.sendMediaWithCaption(file, task.messagePayload);
  } else {
    await adapter.injectPayload(task.messagePayload);
    await adapter.triggerSend();
  }
  return { success: true };
}

async function runTask(task) {
  const adapter = await getAdapter();
  const sanitizedNumber = task.recipient.phone.replace(/[^\d]/g, '');
  const needsNavigation = !window.location.href.includes(sanitizedNumber);

  if (needsNavigation) {
    // Stash before navigating — the reload wipes this script's memory.
    await chrome.storage.session.set({ [PENDING_TASK_KEY]: task });
  }

  const { navigated } = await adapter.openConversation(task.recipient.phone);
  if (navigated) {
    return { pending: true };
  }

  return executeSend(adapter, task);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CHECK_SESSION') {
    getAdapter()
      .then((adapter) => adapter.checkSessionState())
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ connected: false, reason: 'error', error: error.message }));
    return true;
  }

  if (message?.type !== 'EXECUTE_TASK') return false;

  runTask(message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true; // keep the message channel open for the async response
});

// Resume a task that stashed itself right before triggering the reload
// this fresh script instance is now running after.
(async function resumePendingTask() {
  const stored = await chrome.storage.session.get(PENDING_TASK_KEY);
  const task = stored[PENDING_TASK_KEY];
  if (!task) return;

  await chrome.storage.session.remove(PENDING_TASK_KEY);

  try {
    const result = await runTask(task);
    chrome.runtime.sendMessage({ type: 'TASK_RESULT', payload: { taskId: task.taskId, ...result } });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'TASK_RESULT',
      payload: { taskId: task.taskId, success: false, error: error.message },
    });
  }
})();

(async function announceReadiness() {
  const adapter = await getAdapter();
  const state = await adapter.checkSessionState();
  reportConnection(state);
})();
