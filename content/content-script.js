/**
 * Injected into WhatsApp Web. Ingests EXECUTE_TASK commands from the
 * background service worker and drives the platform adapter to perform
 * the actual conversation open / type / send sequence.
 *
 * Uses dynamic import() for its ES module dependencies because content
 * scripts declared via manifest.json content_scripts run as classic
 * scripts, not modules.
 */

let adapterPromise = null;

async function getAdapter() {
  if (!adapterPromise) {
    adapterPromise = import(chrome.runtime.getURL('content/adapters/whatsapp-adapter.js')).then(
      (mod) => new mod.WhatsAppAdapter()
    );
  }
  return adapterPromise;
}

async function reportConnection(connected) {
  chrome.runtime.sendMessage({
    type: 'CONNECTION_STATUS',
    payload: { connected },
  });
}

async function handleExecuteTask(task) {
  const adapter = await getAdapter();

  await adapter.openConversation(task.recipient.phone);

  if (task.mediaBlob) {
    const ext = task.mediaType === 'video' ? 'mp4' : 'jpg';
    const file = new File([task.mediaBlob], `attachment.${ext}`, {
      type: task.mediaBlob.type || (task.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
    });
    await adapter.sendMediaWithCaption(file, task.messagePayload);
  } else {
    await adapter.injectPayload(task.messagePayload);
    await adapter.triggerSend();
  }

  return { success: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CHECK_SESSION') {
    getAdapter()
      .then((adapter) => adapter.validateSession())
      .then((connected) => sendResponse({ connected }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message?.type !== 'EXECUTE_TASK') return false;

  handleExecuteTask(message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true; // keep the message channel open for the async response
});

(async function announceReadiness() {
  const adapter = await getAdapter();
  const sessionValid = await adapter.validateSession();
  reportConnection(sessionValid);
})();
