import { parseCSV } from '../core/csv-parser.js';
import { extractTags, compileTemplate } from '../core/template-engine.js';
import { QueueManager } from '../core/queue-manager.js';

const queueManager = new QueueManager();

// --- DOM references -------------------------------------------------------

const csvFileInput = document.getElementById('csv-file-input');
const manualPasteInput = document.getElementById('manual-paste-input');
const recordCountEl = document.getElementById('record-count');
const detectedTagsEl = document.getElementById('detected-tags');

const templateInput = document.getElementById('template-input');
const chipContainer = document.getElementById('dynamic-chip-container');
const previewOutput = document.getElementById('template-preview-output');

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

let parsedRecords = [];

// --- Recipient ingestion ----------------------------------------------------

function handleCSVText(rawText) {
  const { records } = parseCSV(rawText);
  parsedRecords = records;
  recordCountEl.textContent = String(records.length);
  renderTemplatePreview();
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

function renderTemplatePreview() {
  const template = templateInput.value;
  renderTags(template);

  if (!template || parsedRecords.length === 0) {
    previewOutput.textContent = '';
    return;
  }
  previewOutput.textContent = compileTemplate(template, parsedRecords[0]);
}

templateInput.addEventListener('input', renderTemplatePreview);

// --- Safety guardrail config ------------------------------------------------

function readConfig() {
  return {
    minDelaySeconds: Number(minDelayInput.value) || 15,
    maxDelaySeconds: Number(maxDelayInput.value) || 45,
    hourlyBatchCap: Number(batchCapInput.value) || 25,
    jitterPercent: Number(jitterInput.value) || 20,
  };
}

// --- Queue operations ---------------------------------------------------

function setControlsRunning(isRunning) {
  btnStart.disabled = isRunning;
  btnPause.disabled = !isRunning;
}

btnStart.addEventListener('click', async () => {
  if (parsedRecords.length === 0) {
    appendLog('No recipients parsed. Upload or paste CSV data first.');
    return;
  }
  if (!templateInput.value.trim()) {
    appendLog('Message template is empty.');
    return;
  }

  const config = readConfig();
  await queueManager.initializeQueue(parsedRecords, templateInput.value, config);
  await queueManager.setEngineStatus('RUNNING');

  chrome.runtime.sendMessage({ type: 'ENGINE_START' });
  setControlsRunning(true);
  appendLog(`Queue started: ${parsedRecords.length} recipients.`);
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

// Listen for status broadcasts pushed from the background service worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'QUEUE_SNAPSHOT') {
    renderSnapshot(message.payload);
  } else if (message?.type === 'TASK_LOG') {
    appendLog(message.payload.message);
  } else if (message?.type === 'CONNECTION_STATUS') {
    connectionBadge.textContent = message.payload.connected ? 'Connected' : 'Disconnected';
    connectionBadge.className = `badge ${message.payload.connected ? 'connected' : 'disconnected'}`;
  }
});

// Hydrate UI from any existing persisted queue on panel open.
(async function hydrate() {
  const snapshot = await queueManager.getSnapshot();
  if (snapshot.state) {
    renderSnapshot(snapshot);
  }
})();
