import { parseCSV } from '../core/csv-parser.js';
import { extractTags, compileTemplate } from '../core/template-engine.js';
import { QueueManager } from '../core/queue-manager.js';

const queueManager = new QueueManager();
const MAX_RECIPIENTS = 100;

// --- DOM references -------------------------------------------------------

const csvFileInput = document.getElementById('csv-file-input');
const manualPasteInput = document.getElementById('manual-paste-input');
const quickAddPhoneInput = document.getElementById('quickadd-phone-input');
const quickAddNameInput = document.getElementById('quickadd-name-input');
const btnQuickAdd = document.getElementById('btn-quickadd');
const recordCountEl = document.getElementById('record-count');
const detectedTagsEl = document.getElementById('detected-tags');
const recipientWarningEl = document.getElementById('recipient-warning');

const templateInput = document.getElementById('template-input');
const chipContainer = document.getElementById('dynamic-chip-container');
const previewOutput = document.getElementById('template-preview-output');
const mediaUrlInput = document.getElementById('media-url-input');
const mediaTypeInput = document.getElementById('media-type-input');
const mediaPreviewThumb = document.getElementById('media-preview-thumb');
const mediaPreviewVideoTag = document.getElementById('media-preview-video-tag');

const testPhoneInput = document.getElementById('test-phone-input');
const btnSendTest = document.getElementById('btn-send-test');
const testSendStatusEl = document.getElementById('test-send-status');
const btnRecheckConnection = document.getElementById('btn-recheck-connection');

const minDelayInput = document.getElementById('min-delay-input');
const maxDelayInput = document.getElementById('max-delay-input');
const batchCapInput = document.getElementById('batch-cap-input');
const jitterInput = document.getElementById('jitter-input');

const btnStart = document.getElementById('btn-start-queue');
const btnPause = document.getElementById('btn-pause-queue');
const btnClear = document.getElementById('btn-clear-queue');

const progressFill = document.getElementById('progress-fill');
const cntPending = document.getElementById('cnt-pending');
const cntActive = document.getElementById('cnt-active');
const cntSent = document.getElementById('cnt-sent');
const cntFailed = document.getElementById('cnt-failed');
const logList = document.getElementById('queue-log-list');
const connectionBadge = document.getElementById('connection-badge');

// --- Local state ------------------------------------------------------------

let recipients = [];

// --- Recipient ingestion ----------------------------------------------------

function showRecipientWarning(message) {
  if (!message) {
    recipientWarningEl.hidden = true;
    recipientWarningEl.textContent = '';
    return;
  }
  recipientWarningEl.hidden = false;
  recipientWarningEl.textContent = message;
}

function applyRecipientCap(list) {
  if (list.length > MAX_RECIPIENTS) {
    showRecipientWarning(
      `Only the first ${MAX_RECIPIENTS} recipients are kept (bulk cap). ${list.length - MAX_RECIPIENTS} dropped.`
    );
    return list.slice(0, MAX_RECIPIENTS);
  }
  showRecipientWarning('');
  return list;
}

function setRecipients(list) {
  recipients = applyRecipientCap(list);
  recordCountEl.textContent = String(recipients.length);
  renderTemplatePreview();
}

function handleCSVText(rawText) {
  const { records } = parseCSV(rawText);
  setRecipients(records);
}

csvFileInput.addEventListener('change', async () => {
  const file = csvFileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  handleCSVText(text);
});

manualPasteInput.addEventListener('input', () => {
  if (manualPasteInput.value.trim().length === 0) return;
  handleCSVText(manualPasteInput.value);
});

btnQuickAdd.addEventListener('click', () => {
  const phone = quickAddPhoneInput.value.replace(/[^\d]/g, '');
  if (!phone) {
    showRecipientWarning('Enter a phone number before adding.');
    return;
  }
  const name = quickAddNameInput.value.trim();
  setRecipients([...recipients, { phone, name }]);
  quickAddPhoneInput.value = '';
  quickAddNameInput.value = '';
});

// --- Template composer --------------------------------------------------

function renderTags(template) {
  const tags = extractTags(template);
  detectedTagsEl.textContent = tags.length ? tags.join(', ') : 'None';
  chipContainer.innerHTML = '';
  tags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `{${tag}}`;
    chipContainer.appendChild(chip);
  });
}

function resolveMediaType() {
  const explicit = mediaTypeInput.value;
  if (explicit !== 'auto') return explicit;
  const url = mediaUrlInput.value.trim().toLowerCase();
  return /\.(mp4|mov|webm|m4v)(\?|$)/.test(url) ? 'video' : 'image';
}

function renderMediaPreview() {
  const url = mediaUrlInput.value.trim();

  if (!url) {
    mediaPreviewThumb.hidden = true;
    mediaPreviewVideoTag.hidden = true;
    return;
  }

  if (resolveMediaType() === 'video') {
    mediaPreviewThumb.hidden = true;
    mediaPreviewVideoTag.hidden = false;
  } else {
    mediaPreviewVideoTag.hidden = true;
    mediaPreviewThumb.hidden = false;
    mediaPreviewThumb.src = url;
  }
}

mediaPreviewThumb.addEventListener('error', () => {
  mediaPreviewThumb.hidden = true;
});

function renderTemplatePreview() {
  const template = templateInput.value;
  renderTags(template);
  renderMediaPreview();

  if (!template || recipients.length === 0) {
    previewOutput.textContent = '';
    return;
  }
  previewOutput.textContent = compileTemplate(template, recipients[0]);
}

templateInput.addEventListener('input', renderTemplatePreview);
mediaUrlInput.addEventListener('input', renderMediaPreview);
mediaTypeInput.addEventListener('change', renderMediaPreview);

// --- Safety guardrail config ------------------------------------------------

function readConfig() {
  return {
    minDelaySeconds: Number(minDelayInput.value) || 15,
    maxDelaySeconds: Number(maxDelayInput.value) || 45,
    hourlyBatchCap: Number(batchCapInput.value) || 25,
    jitterPercent: Number(jitterInput.value) || 20,
    mediaUrl: mediaUrlInput.value.trim() || null,
    mediaType: mediaTypeInput.value,
  };
}

// --- Queue operations ---------------------------------------------------

function setControlsRunning(isRunning) {
  btnStart.disabled = isRunning;
  btnPause.disabled = !isRunning;
}

btnStart.addEventListener('click', async () => {
  if (recipients.length === 0) {
    appendLog('No recipients added. Upload CSV, paste CSV, or add a phone number first.');
    return;
  }
  if (!templateInput.value.trim()) {
    appendLog('Message template is empty.');
    return;
  }

  const config = readConfig();
  await queueManager.initializeQueue(recipients, templateInput.value, config);
  await queueManager.setEngineStatus('RUNNING');

  chrome.runtime.sendMessage({ type: 'ENGINE_START' });
  setControlsRunning(true);
  appendLog(`Queue started: ${recipients.length} recipients.`);
});

btnPause.addEventListener('click', async () => {
  await queueManager.setEngineStatus('PAUSED');
  chrome.runtime.sendMessage({ type: 'ENGINE_PAUSE' });
  setControlsRunning(false);
  appendLog('Queue paused.');
});

btnClear.addEventListener('click', async () => {
  await queueManager.clearQueue();
  chrome.runtime.sendMessage({ type: 'ENGINE_CLEAR' });
  setControlsRunning(false);
  resetProgressUI();
  appendLog('Queue cleared.');
});

// --- Progress / status rendering -----------------------------------------

function resetProgressUI() {
  progressFill.style.width = '0%';
  cntPending.textContent = '0';
  cntActive.textContent = '0';
  cntSent.textContent = '0';
  cntFailed.textContent = '0';
  logList.innerHTML = '';
}

function appendLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span>${message}</span><span>${time}</span>`;
  logList.prepend(entry);
}

function renderSnapshot({ queue, state }) {
  if (!queue || !state) return;

  const pending = queue.filter((t) => t.status === 'PENDING').length;
  const active = queue.filter((t) => t.status === 'PROCESSING').length;
  const sent = queue.filter((t) => t.status === 'SENT').length;
  const failed = queue.filter((t) => t.status === 'FAILED').length;

  cntPending.textContent = String(pending);
  cntActive.textContent = String(active);
  cntSent.textContent = String(sent);
  cntFailed.textContent = String(failed);

  const completed = sent + failed;
  const percent = state.totalTasks > 0 ? Math.round((completed / state.totalTasks) * 100) : 0;
  progressFill.style.width = `${percent}%`;

  setControlsRunning(state.status === 'RUNNING');
}

const DISCONNECT_REASON_TEXT = {
  'no-tab': 'No WhatsApp Tab',
  qr: 'Scan QR Code',
  'no-content-script': 'Reloading...',
  error: 'Detection Error',
  unknown: 'Disconnected',
};

function renderConnection(status) {
  const connected = Boolean(status?.connected);
  connectionBadge.textContent = connected
    ? 'Connected'
    : DISCONNECT_REASON_TEXT[status?.reason] || 'Disconnected';
  connectionBadge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
}

async function checkConnection() {
  connectionBadge.textContent = 'Checking...';
  const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
  renderConnection(status);
}

btnRecheckConnection.addEventListener('click', checkConnection);

// --- Test send (bypasses the queue entirely) --------------------------

btnSendTest.addEventListener('click', async () => {
  const phone = testPhoneInput.value.replace(/[^\d]/g, '');
  if (!phone) {
    testSendStatusEl.textContent = 'Enter a phone number to send the test to.';
    testSendStatusEl.className = 'test-send-status error';
    return;
  }
  if (!templateInput.value.trim()) {
    testSendStatusEl.textContent = 'Message template is empty.';
    testSendStatusEl.className = 'test-send-status error';
    return;
  }

  const sampleRecord = recipients[0] || {};
  const messagePayload = compileTemplate(templateInput.value, sampleRecord);
  const config = readConfig();

  btnSendTest.disabled = true;
  testSendStatusEl.textContent = 'Sending test message...';
  testSendStatusEl.className = 'test-send-status';

  const result = await chrome.runtime.sendMessage({
    type: 'SEND_TEST',
    payload: {
      phone,
      messagePayload,
      mediaUrl: config.mediaUrl,
      mediaType: config.mediaType,
    },
  });

  btnSendTest.disabled = false;
  if (result?.success) {
    testSendStatusEl.textContent = `Test sent to ${phone}.`;
    testSendStatusEl.className = 'test-send-status success';
  } else {
    testSendStatusEl.textContent = `Failed: ${result?.error || 'unknown error'}`;
    testSendStatusEl.className = 'test-send-status error';
  }
});

// Listen for status broadcasts pushed from the background service worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'QUEUE_SNAPSHOT') {
    renderSnapshot(message.payload);
  } else if (message?.type === 'TASK_LOG') {
    appendLog(message.payload.message);
  } else if (message?.type === 'CONNECTION_STATUS') {
    renderConnection(message.payload);
  }
});

// Hydrate UI from any existing persisted queue on panel open, and actively
// re-check the WhatsApp tab's session (rather than waiting for a push that
// may have fired before this panel was even open to receive it).
(async function hydrate() {
  const snapshot = await queueManager.getSnapshot();
  if (snapshot.state) {
    renderSnapshot(snapshot);
  }

  await checkConnection();
})();
