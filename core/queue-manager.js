import { compileTemplate } from './template-engine.js';

/**
 * Production Queue Manager Engine
 * Handles storage-backed state recovery, scheduling, and concurrency locks.
 */
export class QueueManager {
  constructor() {
    this.QUEUE_KEY = 'outreach_queue_data';
    this.STATE_KEY = 'outreach_engine_state';
    this.CONFIG_KEY = 'outreach_config_data';
    this.HISTORY_KEY = 'outreach_history_data';
    // History is browser-local only (chrome.storage.local, never synced)
    // and self-prunes past this window so it can't grow forever.
    this.HISTORY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
    this.HISTORY_MAX_ENTRIES = 1000;
  }

  /**
   * Initializes a new queue dataset in storage.
   */
  async initializeQueue(recipients, template, config) {
    const queue = recipients.map((recipient, idx) => ({
      id: `task_${Date.now()}_${idx}`,
      recipient,
      messagePayload: compileTemplate(template, recipient),
      mediaUrl: config?.mediaUrl || null,
      mediaType: config?.mediaType || 'auto',
      useUploadedMedia: Boolean(config?.useUploadedMedia),
      sendAsDocument: Boolean(config?.sendAsDocument),
      status: 'PENDING', // PENDING, PROCESSING, SENT, FAILED
      attempts: 0,
      maxAttempts: 3,
      lastUpdated: Date.now(),
      errorDetail: null,
    }));

    const engineState = {
      status: 'IDLE', // IDLE, RUNNING, PAUSED, COMPLETED
      currentIndex: 0,
      totalTasks: queue.length,
      successCount: 0,
      failureCount: 0,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      windowStart: Date.now(),
      windowCount: 0,
    };

    await chrome.storage.local.set({
      [this.QUEUE_KEY]: queue,
      [this.STATE_KEY]: engineState,
      [this.CONFIG_KEY]: config,
    });

    return { queue, engineState };
  }

  /**
   * Fetches the next available pending task with atomic locking logic.
   */
  async acquireNextTask() {
    const data = await chrome.storage.local.get([this.QUEUE_KEY, this.STATE_KEY]);
    const queue = data[this.QUEUE_KEY] || [];
    const state = data[this.STATE_KEY] || {};

    if (state.status !== 'RUNNING') return null;

    const targetIdx = queue.findIndex((item) => item.status === 'PENDING');
    if (targetIdx === -1) {
      state.status = 'COMPLETED';
      await chrome.storage.local.set({ [this.STATE_KEY]: state });
      return null;
    }

    // Atomic task reservation
    queue[targetIdx].status = 'PROCESSING';
    queue[targetIdx].attempts += 1;
    queue[targetIdx].lastUpdated = Date.now();
    state.currentIndex = targetIdx;
    state.lastHeartbeat = Date.now();

    await chrome.storage.local.set({
      [this.QUEUE_KEY]: queue,
      [this.STATE_KEY]: state,
    });

    return queue[targetIdx];
  }

  /**
   * Finalizes task execution state following content-script execution.
   */
  async recordTaskOutcome(taskId, isSuccess, errorDetail = null) {
    const data = await chrome.storage.local.get([this.QUEUE_KEY, this.STATE_KEY]);
    const queue = data[this.QUEUE_KEY] || [];
    const state = data[this.STATE_KEY] || {};

    const taskIndex = queue.findIndex((item) => item.id === taskId);
    if (taskIndex === -1) return null;

    const task = queue[taskIndex];

    if (isSuccess) {
      task.status = 'SENT';
      task.errorDetail = null;
      state.successCount += 1;
    } else {
      if (task.attempts < task.maxAttempts) {
        task.status = 'PENDING'; // Return to queue for retry
      } else {
        task.status = 'FAILED';
        state.failureCount += 1;
      }
      task.errorDetail = errorDetail;
    }

    task.lastUpdated = Date.now();
    state.lastHeartbeat = Date.now();

    await chrome.storage.local.set({
      [this.QUEUE_KEY]: queue,
      [this.STATE_KEY]: state,
    });

    // Only log terminal outcomes — a failure that still has retries left
    // leaves task.status back at 'PENDING' and isn't final yet.
    if (task.status === 'SENT' || task.status === 'FAILED') {
      await this._appendHistoryEntry({
        id: task.id,
        phone: task.recipient?.phone || '',
        name: task.recipient?.name || '',
        message: task.messagePayload,
        hadMedia: Boolean(task.mediaUrl || task.useUploadedMedia),
        status: task.status,
        error: task.errorDetail,
        timestamp: task.lastUpdated,
      });
    }

    return { task, state };
  }

  /**
   * Appends one entry to the persistent send history, pruning anything
   * older than HISTORY_MAX_AGE_MS and capping total size so this can't
   * grow unbounded across long-running usage.
   */
  async _appendHistoryEntry(entry) {
    const data = await chrome.storage.local.get(this.HISTORY_KEY);
    const cutoff = Date.now() - this.HISTORY_MAX_AGE_MS;
    const history = (data[this.HISTORY_KEY] || []).filter((item) => item.timestamp >= cutoff);

    history.unshift(entry);
    if (history.length > this.HISTORY_MAX_ENTRIES) {
      history.length = this.HISTORY_MAX_ENTRIES;
    }

    await chrome.storage.local.set({ [this.HISTORY_KEY]: history });
  }

  /**
   * Returns history entries from the last HISTORY_MAX_AGE_MS, newest first.
   */
  async getHistory() {
    const data = await chrome.storage.local.get(this.HISTORY_KEY);
    const cutoff = Date.now() - this.HISTORY_MAX_AGE_MS;
    return (data[this.HISTORY_KEY] || []).filter((item) => item.timestamp >= cutoff);
  }

  async clearHistory() {
    await chrome.storage.local.remove(this.HISTORY_KEY);
  }

  /**
   * Manually sets the operational state (e.g., RUNNING, PAUSED).
   */
  async setEngineStatus(newStatus) {
    const data = await chrome.storage.local.get([this.STATE_KEY]);
    const state = data[this.STATE_KEY] || {};
    state.status = newStatus;
    state.lastHeartbeat = Date.now();
    await chrome.storage.local.set({ [this.STATE_KEY]: state });
    return state;
  }

  /**
   * Reads back the full queue + state + config snapshot for UI rendering.
   */
  async getSnapshot() {
    const data = await chrome.storage.local.get([
      this.QUEUE_KEY,
      this.STATE_KEY,
      this.CONFIG_KEY,
    ]);
    return {
      queue: data[this.QUEUE_KEY] || [],
      state: data[this.STATE_KEY] || null,
      config: data[this.CONFIG_KEY] || null,
    };
  }

  /**
   * Clears all queue/state/config data, e.g. on "Clear Queue".
   */
  async clearQueue() {
    await chrome.storage.local.remove([this.QUEUE_KEY, this.STATE_KEY, this.CONFIG_KEY]);
  }
}
