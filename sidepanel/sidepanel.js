import { parseCSV } from '../core/csv-parser.js';
import { extractTags, compileTemplate } from '../core/template-engine.js';
import { QueueManager } from '../core/queue-manager.js';

const queueManager = new QueueManager();
const MAX_RECIPIENTS = 100;
// chrome.storage.session is hard-capped at 10MB total (not raisable, even
// with extra permissions) and base64 inflates raw bytes by ~1.33x, so the
// real ceiling for an uploaded file is well under 10MB raw. 7MB leaves
// headroom for the small pending-task JSON also living in that storage.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;

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
const mediaFileInput = document.getElementById('media-file-input');
const sendAsDocumentInput = document.getElementById('send-as-document-input');
const uploadFileNameEl = document.getElementById('upload-file-name');
const mediaTabButtons = document.querySelectorAll('.media-tab');
const mediaTabPanels = {
  upload: document.getElementById('media-tab-upload'),
  link: document.getElementById('media-tab-link'),
};

const testPhoneInput = document.getElementById('test-phone-input');
const btnSendTest = document.getElementById('btn-send-test');
const testSendStatusEl = document.getElementById('test-send-status');
const btnRecheckConnection = document.getElementById('btn-recheck-connection');
// [data-marker] excludes the link button — it shares .fmt-btn for styling
// but has its own click handler (see btnInsertLink below), not a wrap marker.
const fmtButtons = document.querySelectorAll('.fmt-btn[data-marker]');
const btnInsertLink = document.getElementById('btn-insert-link');
const btnCopyShareLink = document.getElementById('btn-copy-share-link');
const shareLinkStatusEl = document.getElementById('share-link-status');

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
let activeMediaTab = 'upload';
let hasUploadedMedia = false;
let uploadedMediaType = null;
let uploadedObjectUrl = null;

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

// --- Formatting toolbar (WhatsApp's own markdown, not HTML) ----------------

function wrapSelection(marker) {
  const start = templateInput.selectionStart;
  const end = templateInput.selectionEnd;
  const value = templateInput.value;
  const selected = value.slice(start, end) || 'text';

  templateInput.value = `${value.slice(0, start)}${marker}${selected}${marker}${value.slice(end)}`;
  templateInput.focus();
  templateInput.setSelectionRange(start + marker.length, start + marker.length + selected.length);
  renderTemplatePreview();
}

fmtButtons.forEach((btn) => {
  btn.addEventListener('click', () => wrapSelection(btn.dataset.marker));
});

function renderWhatsAppMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/```([^`]+)```/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    // WhatsApp auto-detects raw URLs and turns them into a live link
    // preview card on its own — this just mirrors that in our preview.
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function insertAtCursor(text) {
  const start = templateInput.selectionStart;
  const end = templateInput.selectionEnd;
  const value = templateInput.value;

  templateInput.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
  templateInput.focus();
  const cursor = start + text.length;
  templateInput.setSelectionRange(cursor, cursor);
  renderTemplatePreview();
}

btnInsertLink.addEventListener('click', () => {
  const url = prompt('Paste the link (https://...)');
  if (!url || !url.trim()) return;

  const start = templateInput.selectionStart;
  const precedingChar = templateInput.value.slice(0, start).slice(-1);
  const needsLeadingSpace = precedingChar && !/\s/.test(precedingChar);

  insertAtCursor(`${needsLeadingSpace ? ' ' : ''}${url.trim()}`);
});

// --- Share as link (wa.me click-to-chat, no automation involved) -----------

function buildShareLink(messageText) {
  const phone = testPhoneInput.value.replace(/[^\d]/g, '');
  const base = phone ? `https://wa.me/${phone}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(messageText)}`;
}

btnCopyShareLink.addEventListener('click', async () => {
  const template = templateInput.value.trim();
  if (!template) {
    shareLinkStatusEl.textContent = 'Write a message first.';
    return;
  }
  const sampleRecord = recipients[0] || {};
  const messageText = compileTemplate(template, sampleRecord);
  const link = buildShareLink(messageText);

  try {
    await navigator.clipboard.writeText(link);
    shareLinkStatusEl.textContent = 'Link copied!';
  } catch (e) {
    shareLinkStatusEl.textContent = link;
  }
  setTimeout(() => {
    shareLinkStatusEl.textContent = '';
  }, 4000);
});

function resolveLinkMediaType() {
  const explicit = mediaTypeInput.value;
  if (explicit !== 'auto') return explicit;
  const url = mediaUrlInput.value.trim().toLowerCase();
  return /\.(mp4|mov|webm|m4v)(\?|$)/.test(url) ? 'video' : 'image';
}

function showPreview(kind, srcForImage) {
  if (kind === 'video') {
    mediaPreviewThumb.hidden = true;
    mediaPreviewVideoTag.hidden = false;
  } else if (kind === 'image') {
    mediaPreviewVideoTag.hidden = true;
    mediaPreviewThumb.hidden = false;
    mediaPreviewThumb.src = srcForImage;
  } else {
    mediaPreviewThumb.hidden = true;
    mediaPreviewVideoTag.hidden = true;
  }
}

function renderMediaPreview() {
  if (activeMediaTab === 'upload') {
    if (!hasUploadedMedia) {
      showPreview(null);
      return;
    }
    showPreview(uploadedMediaType, uploadedObjectUrl);
    return;
  }

  const url = mediaUrlInput.value.trim();
  if (!url) {
    showPreview(null);
    return;
  }
  showPreview(resolveLinkMediaType(), url);
}

mediaPreviewThumb.addEventListener('error', () => {
  mediaPreviewThumb.hidden = true;
});

// --- Media tabs (Upload File / Paste Link) ------------------------------

function setActiveMediaTab(tab) {
  activeMediaTab = tab;
  mediaTabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  mediaTabPanels.upload.hidden = tab !== 'upload';
  mediaTabPanels.link.hidden = tab !== 'link';
  renderMediaPreview();
}

mediaTabButtons.forEach((btn) => {
  btn.addEventListener('click', () => setActiveMediaTab(btn.dataset.tab));
});

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

mediaFileInput.addEventListener('change', async () => {
  const file = mediaFileInput.files?.[0];
  if (!file) return;

  if (file.size > MAX_UPLOAD_BYTES) {
    uploadFileNameEl.hidden = false;
    uploadFileNameEl.textContent = `Too large (${Math.round(file.size / 1024 / 1024)}MB) — max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`;
    mediaFileInput.value = '';
    hasUploadedMedia = false;
    renderMediaPreview();
    return;
  }

  uploadFileNameEl.hidden = false;
  uploadFileNameEl.textContent = 'Uploading...';

  const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  const result = await chrome.runtime.sendMessage({
    type: 'STORE_UPLOADED_MEDIA',
    payload: { base64, mimeType: file.type, mediaType },
  });

  if (!result?.success) {
    uploadFileNameEl.textContent = `Upload failed: ${result?.error || 'unknown error'}`;
    hasUploadedMedia = false;
    renderMediaPreview();
    return;
  }

  if (uploadedObjectUrl) URL.revokeObjectURL(uploadedObjectUrl);
  uploadedObjectUrl = URL.createObjectURL(file);
  uploadedMediaType = mediaType;
  hasUploadedMedia = true;
  uploadFileNameEl.textContent = `${file.name} ready.`;
  renderMediaPreview();
});

function renderTemplatePreview() {
  const template = templateInput.value;
  renderTags(template);
  renderMediaPreview();

  if (!template) {
    previewOutput.textContent = '';
    return;
  }
  // Preview against recipient #1 once loaded; before that, still preview
  // against an empty record so {tags} just show literally instead of the
  // whole preview going blank while you're still writing the message.
  const compiled = compileTemplate(template, recipients[0] || {});
  previewOutput.innerHTML = renderWhatsAppMarkdown(compiled);
}

templateInput.addEventListener('input', renderTemplatePreview);
mediaUrlInput.addEventListener('input', renderMediaPreview);
mediaTypeInput.addEventListener('change', renderMediaPreview);

// --- Safety guardrail config ------------------------------------------------

function readConfig() {
  const useUploadedMedia = activeMediaTab === 'upload' && hasUploadedMedia;
  return {
    minDelaySeconds: Number(minDelayInput.value) || 15,
    maxDelaySeconds: Number(maxDelayInput.value) || 45,
    hourlyBatchCap: Number(batchCapInput.value) || 25,
    jitterPercent: Number(jitterInput.value) || 20,
    mediaUrl: activeMediaTab === 'link' ? mediaUrlInput.value.trim() || null : null,
    mediaType: activeMediaTab === 'upload' ? uploadedMediaType || 'auto' : mediaTypeInput.value,
    useUploadedMedia,
    sendAsDocument: sendAsDocumentInput.checked,
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
      useUploadedMedia: config.useUploadedMedia,
      sendAsDocument: config.sendAsDocument,
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
