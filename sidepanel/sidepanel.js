import { parseCSV } from '../core/csv-parser.js';
import { extractTags, compileTemplate } from '../core/template-engine.js';
import { QueueManager } from '../core/queue-manager.js';

const queueManager = new QueueManager();
const DRAFT_KEY = 'outreach_draft_data';
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024; // 7MB raw limit for session storage

// --- DOM references -------------------------------------------------------

const btnThemeToggle = document.getElementById('btn-theme-toggle');
const themeIconEl = document.getElementById('theme-icon');
const themeLabelEl = document.getElementById('theme-label');
const btnOpenTab = document.getElementById('btn-open-tab');

const csvFileInput = document.getElementById('csv-file-input');
const manualPasteInput = document.getElementById('manual-paste-input');
const quickAddPhoneInput = document.getElementById('quickadd-phone-input');
const quickAddNameInput = document.getElementById('quickadd-name-input');
const btnQuickAdd = document.getElementById('btn-quickadd');
const recordCountEl = document.getElementById('record-count');
const detectedTagsEl = document.getElementById('detected-tags');
const recipientWarningEl = document.getElementById('recipient-warning');

const templateInput = document.getElementById('template-input');
const btnSaveDraft = document.getElementById('btn-save-draft');
const btnLoadDraft = document.getElementById('btn-load-draft');
const btnClearDraft = document.getElementById('btn-clear-draft');
const draftStatusEl = document.getElementById('draft-status');
const chipContainer = document.getElementById('dynamic-chip-container');
const previewOutput = document.getElementById('template-preview-output');

// Media / Attachment references
const mediaUrlInput = document.getElementById('media-url-input');
const mediaTypeInput = document.getElementById('media-type-input');
const mediaPreviewThumb = document.getElementById('media-preview-thumb');
const mediaPreviewVideoTag = document.getElementById('media-preview-video-tag');
const mediaPreviewDocTag = document.getElementById('media-preview-doc-tag');
const mediaPreviewDocName = document.getElementById('media-preview-doc-name');
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

const fmtButtons = document.querySelectorAll('.fmt-btn[data-marker]');
const btnInsertLink = document.getElementById('btn-insert-link');
const linkInsertRow = document.getElementById('link-insert-row');
const linkInsertInput = document.getElementById('link-insert-input');
const linkTextInput = document.getElementById('link-text-input');
const btnConfirmLink = document.getElementById('btn-confirm-link');
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

const historyListEl = document.getElementById('history-list');
const historyCountEl = document.getElementById('history-count');
const btnClearHistory = document.getElementById('btn-clear-history');

// --- Local state ------------------------------------------------------------

let recipients = [];
let activeMediaTab = 'upload';
let hasUploadedMedia = false;
let uploadedMediaType = 'image';
let uploadedFileName = '';
let uploadedObjectUrl = null;

// --- Theme Management -------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    if (themeIconEl) themeIconEl.textContent = '☀️';
    if (themeLabelEl) themeLabelEl.textContent = 'Light';
  } else {
    if (themeIconEl) themeIconEl.textContent = '🌙';
    if (themeLabelEl) themeLabelEl.textContent = 'Dark';
  }
}

async function initTheme() {
  try {
    const { ui_theme } = await chrome.storage.local.get('ui_theme');
    const preferred = ui_theme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(preferred);
  } catch (e) {
    applyTheme('light');
  }
}

if (btnThemeToggle) {
  btnThemeToggle.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      await chrome.storage.local.set({ ui_theme: next });
    } catch (e) {}
  });
}
initTheme();

// --- Open Full Tab Mode -----------------------------------------------------

if (btnOpenTab) {
  if (chrome.tabs && chrome.tabs.getCurrent) {
    chrome.tabs.getCurrent((currentTab) => {
      if (currentTab) {
        // Already running as a full tab — hide button in full tab mode
        btnOpenTab.hidden = true;
      } else {
        // Running inside Chrome Side Panel — click opens tab and closes side panel
        btnOpenTab.addEventListener('click', () => {
          chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') }, () => {
            window.close();
          });
        });
      }
    });
  } else {
    btnOpenTab.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') }, () => {
        window.close();
      });
    });
  }
}

// --- Recipient ingestion (Unlimited) ----------------------------------------

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
  showRecipientWarning('');
  return list; // Unlimited recipients supported
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

// --- Template composer ------------------------------------------------------

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

let savedLinkCursorPos = null;

btnInsertLink.addEventListener('click', () => {
  savedLinkCursorPos = templateInput.selectionStart;
  linkInsertInput.value = '';
  linkTextInput.value = '';
  linkInsertRow.hidden = false;
  linkTextInput.focus();
});

function confirmLinkInsert() {
  const url = linkInsertInput.value.trim();
  const linkText = linkTextInput.value.trim();
  linkInsertRow.hidden = true;
  if (!url) return;

  const cursorPos = savedLinkCursorPos ?? templateInput.value.length;
  const precedingChar = templateInput.value.slice(0, cursorPos).slice(-1);
  const needsLeadingSpace = precedingChar && !/\s/.test(precedingChar);
  const linkContent = linkText ? `${linkText}: ${url}` : url;

  templateInput.setSelectionRange(cursorPos, cursorPos);
  insertAtCursor(`${needsLeadingSpace ? ' ' : ''}${linkContent}`);
}

btnConfirmLink.addEventListener('click', confirmLinkInsert);
function handleLinkRowKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    confirmLinkInsert();
  } else if (event.key === 'Escape') {
    linkInsertRow.hidden = true;
  }
}
linkInsertInput.addEventListener('keydown', handleLinkRowKeydown);
linkTextInput.addEventListener('keydown', handleLinkRowKeydown);

// --- Share as link (wa.me click-to-chat) -----------------------------------

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

// --- Media & PDF Attachment Logic ------------------------------------------

function resolveLinkMediaType() {
  const explicit = mediaTypeInput.value;
  if (explicit !== 'auto') return explicit;
  const url = mediaUrlInput.value.trim().toLowerCase();
  if (/\.pdf(\?|$)/.test(url)) return 'pdf';
  if (/\.(mp4|mov|webm|m4v)(\?|$)/.test(url)) return 'video';
  if (/\.(docx?|xlsx?|pptx?|txt|zip)(\?|$)/.test(url)) return 'document';
  return 'image';
}

function showPreview(kind, srcOrName) {
  mediaPreviewThumb.hidden = true;
  mediaPreviewVideoTag.hidden = true;
  mediaPreviewDocTag.hidden = true;

  if (kind === 'video') {
    mediaPreviewVideoTag.hidden = false;
  } else if (kind === 'pdf' || kind === 'document') {
    mediaPreviewDocTag.hidden = false;
    mediaPreviewDocName.textContent = srcOrName || (kind === 'pdf' ? 'PDF Document' : 'Document');
  } else if (kind === 'image') {
    mediaPreviewThumb.hidden = false;
    mediaPreviewThumb.src = srcOrName || '';
  }
}

function renderMediaPreview() {
  if (activeMediaTab === 'upload') {
    if (!hasUploadedMedia) {
      showPreview(null);
      return;
    }
    showPreview(uploadedMediaType, uploadedMediaType === 'image' ? uploadedObjectUrl : uploadedFileName);
    return;
  }

  const url = mediaUrlInput.value.trim();
  if (!url) {
    showPreview(null);
    return;
  }
  const detectedType = resolveLinkMediaType();
  if (detectedType === 'pdf' || detectedType === 'document') {
    sendAsDocumentInput.checked = true;
  }
  showPreview(detectedType, detectedType === 'image' ? url : (url.substring(url.lastIndexOf('/') + 1) || url));
}

mediaPreviewThumb.addEventListener('error', () => {
  mediaPreviewThumb.hidden = true;
});

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
    uploadFileNameEl.textContent = `Too large (${Math.round(file.size / 1024 / 1024)}MB) — max local upload is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB (use Paste Link for larger files).`;
    mediaFileInput.value = '';
    hasUploadedMedia = false;
    renderMediaPreview();
    return;
  }

  uploadFileNameEl.hidden = false;
  uploadFileNameEl.textContent = 'Processing file...';

  let mediaType = 'image';
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    mediaType = 'pdf';
    sendAsDocumentInput.checked = true;
  } else if (file.type.startsWith('video/')) {
    mediaType = 'video';
  } else if (!file.type.startsWith('image/')) {
    mediaType = 'document';
    sendAsDocumentInput.checked = true;
  }

  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  const result = await chrome.runtime.sendMessage({
    type: 'STORE_UPLOADED_MEDIA',
    payload: {
      base64,
      mimeType: file.type || (mediaType === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      mediaType,
      fileName: file.name,
    },
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
  uploadedFileName = file.name;
  hasUploadedMedia = true;
  uploadFileNameEl.textContent = `${file.name} ready.`;
  renderMediaPreview();
});

mediaUrlInput.addEventListener('input', renderMediaPreview);
mediaTypeInput.addEventListener('change', () => {
  if (mediaTypeInput.value === 'pdf' || mediaTypeInput.value === 'document') {
    sendAsDocumentInput.checked = true;
  }
  renderMediaPreview();
});

// --- Draft Management -------------------------------------------------------

function flashDraftStatus(text) {
  draftStatusEl.textContent = text;
  setTimeout(() => {
    if (draftStatusEl.textContent === text) draftStatusEl.textContent = '';
  }, 2500);
}

btnSaveDraft.addEventListener('click', async () => {
  const draft = {
    template: templateInput.value,
    mediaUrl: mediaUrlInput.value,
    mediaType: mediaTypeInput.value,
    sendAsDocument: sendAsDocumentInput.checked,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ [DRAFT_KEY]: draft });
  flashDraftStatus('Draft saved.');
});

btnLoadDraft.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(DRAFT_KEY);
  const draft = data[DRAFT_KEY];
  if (!draft) {
    flashDraftStatus('No saved draft.');
    return;
  }
  templateInput.value = draft.template || '';
  if (draft.mediaUrl) {
    mediaUrlInput.value = draft.mediaUrl;
    setActiveMediaTab('link');
  }
  if (draft.mediaType) mediaTypeInput.value = draft.mediaType;
  if (typeof draft.sendAsDocument === 'boolean') {
    sendAsDocumentInput.checked = draft.sendAsDocument;
  }
  renderTemplatePreview();
  flashDraftStatus('Draft loaded.');
});

btnClearDraft.addEventListener('click', async () => {
  await chrome.storage.local.remove(DRAFT_KEY);
  flashDraftStatus('Draft cleared.');
});

function renderTemplatePreview() {
  const template = templateInput.value;
  renderTags(template);
  renderMediaPreview();

  if (!template) {
    previewOutput.textContent = '';
    return;
  }
  const compiled = compileTemplate(template, recipients[0] || {});
  previewOutput.innerHTML = renderWhatsAppMarkdown(compiled);
}

templateInput.addEventListener('input', renderTemplatePreview);

// --- Safety guardrail config ------------------------------------------------

function readConfig() {
  const useUploadedMedia = activeMediaTab === 'upload' && hasUploadedMedia;
  return {
    minDelaySeconds: Number(minDelayInput.value) || 15,
    maxDelaySeconds: Number(maxDelayInput.value) || 45,
    hourlyBatchCap: Number(batchCapInput.value) || 300,
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
  updateQueueCounts({ pending: 0, processing: 0, sent: 0, failed: 0 });
  updateProgress(0);
  appendLog('Queue cleared.');
});

// --- UI Sync ----------------------------------------------------------------

function updateQueueCounts({ pending = 0, processing = 0, sent = 0, failed = 0 }) {
  cntPending.textContent = String(pending);
  cntActive.textContent = String(processing);
  cntSent.textContent = String(sent);
  cntFailed.textContent = String(failed);
}

function updateProgress(percent) {
  progressFill.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
}

function appendLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const textSpan = document.createElement('span');
  textSpan.textContent = message;

  const timeSpan = document.createElement('span');
  timeSpan.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  entry.appendChild(textSpan);
  entry.appendChild(timeSpan);
  logList.appendChild(entry);
  logList.scrollTop = logList.scrollHeight;
}

function applySnapshot(state) {
  if (!state) return;

  const completed = (state.successCount || 0) + (state.failureCount || 0);
  const percent = state.totalTasks > 0 ? Math.round((completed / state.totalTasks) * 100) : 0;
  updateProgress(percent);

  setControlsRunning(state.status === 'RUNNING');

  if (state.counts) {
    updateQueueCounts(state.counts);
  }
}

// --- Connection status ------------------------------------------------------

function setConnectionBadge(status) {
  connectionBadge.className = 'badge';
  if (status.connected) {
    connectionBadge.classList.add('connected');
    connectionBadge.textContent = 'Connected';
    connectionBadge.title = 'WhatsApp Web is active and ready to send.';
  } else {
    connectionBadge.classList.add('disconnected');
    switch (status.reason) {
      case 'no_tab':
        connectionBadge.textContent = 'No WhatsApp Tab';
        connectionBadge.title = 'Open web.whatsapp.com in a tab.';
        break;
      case 'qr':
        connectionBadge.textContent = 'Scan QR Code';
        connectionBadge.title = 'WhatsApp Web is open but waiting for phone scan.';
        break;
      case 'injecting':
        connectionBadge.textContent = 'Reloading...';
        connectionBadge.title = 'Extension is connecting to the tab.';
        break;
      default:
        connectionBadge.textContent = 'Detection Error';
        connectionBadge.title = 'Could not verify WhatsApp page state.';
    }
  }
}

btnRecheckConnection.addEventListener('click', async () => {
  connectionBadge.className = 'badge';
  connectionBadge.textContent = 'Checking...';
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
    setConnectionBadge(status || { connected: false, reason: 'unknown' });
  } catch (e) {
    setConnectionBadge({ connected: false, reason: 'unknown' });
  }
});

// --- Test send --------------------------------------------------------------

btnSendTest.addEventListener('click', async () => {
  const phone = testPhoneInput.value.replace(/[^\d]/g, '');
  if (!phone) {
    testSendStatusEl.textContent = 'Enter a test phone number.';
    testSendStatusEl.className = 'test-send-status error';
    return;
  }
  if (!templateInput.value.trim()) {
    testSendStatusEl.textContent = 'Write a message first.';
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

// --- Send history (last 5 days, browser-local) -------------------------------

function formatHistoryTime(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderHistory(entries) {
  historyCountEl.textContent = `${entries.length} in last 5 days`;
  historyListEl.innerHTML = '';

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No messages sent yet.';
    historyListEl.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.addEventListener('click', () => item.classList.toggle('expanded'));

    const row = document.createElement('div');
    row.className = 'history-item-row';

    const who = document.createElement('span');
    who.className = 'history-item-who';
    who.textContent = entry.name ? `${entry.name} (${entry.phone})` : entry.phone;

    const time = document.createElement('span');
    time.className = 'history-item-time';
    time.textContent = formatHistoryTime(entry.timestamp);

    row.appendChild(who);
    row.appendChild(time);
    item.appendChild(row);

    const full = document.createElement('div');
    full.className = 'history-item-full';
    full.textContent = (entry.hadMedia ? '[Attachment] ' : '') + (entry.message || '');
    item.appendChild(full);

    historyListEl.appendChild(item);
  });
}

async function refreshHistory() {
  const entries = await queueManager.getHistory();
  renderHistory(entries);
}

btnClearHistory.addEventListener('click', async () => {
  await queueManager.clearHistory();
  renderHistory([]);
});

// --- Background message listener --------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'QUEUE_SNAPSHOT':
      applySnapshot(message.payload);
      break;
    case 'TASK_LOG':
      appendLog(message.payload.message);
      break;
    case 'CONNECTION_STATUS':
      setConnectionBadge(message.payload);
      break;
    case 'TASK_COMPLETED':
      refreshHistory();
      break;
    default:
      break;
  }
});

// --- Initialization ---------------------------------------------------------

async function initialize() {
  const snapshot = await queueManager.getSnapshot();
  applySnapshot(snapshot);
  refreshHistory();

  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
    setConnectionBadge(status || { connected: false, reason: 'unknown' });
  } catch (e) {
    setConnectionBadge({ connected: false, reason: 'unknown' });
  }

  renderTemplatePreview();
}

initialize();
