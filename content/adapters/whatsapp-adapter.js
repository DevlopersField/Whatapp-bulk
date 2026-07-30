import { MessagingAdapter } from './base-adapter.js';
import { DOMSelectorEngine } from '../dom-selector-engine.js';

/**
 * Concrete WhatsApp Web Messaging Adapter Implementation.
 *
 * Media send simulates a real drag-and-drop of a File onto the open
 * conversation, the same way WhatsApp Web accepts a file dropped from the
 * OS. WhatsApp's own drop handler doesn't check event.isTrusted, only
 * event.dataTransfer.files, so a synthetic DragEvent carrying a real File
 * is accepted the same way. This depends on WhatsApp's current DOM/modal
 * structure and can break on their frontend updates like any other selector
 * here.
 */
export class WhatsAppAdapter extends MessagingAdapter {
  constructor() {
    super();
    // Prioritized fallback selector matrix
    this.SELECTORS = {
      qrCode: [
        'canvas[aria-label="Scan this QR code to link a device!"]',
        'canvas[aria-label="Scan me!"]',
        'div[data-testid="qrcode"]',
      ],
      // Anchors for "the main app shell is loaded and a chat list is showing"
      // — deliberately broad and redundant since WhatsApp Web's DOM/classes
      // change across redesigns far more often than these structural landmarks.
      loggedInAnchor: [
        '#side',
        '#pane-side',
        'div[aria-label="Chat list"]',
        'div[data-testid="chat-list"]',
        'div[contenteditable="true"][data-tab="3"]',
        'div[title="Search or start new chat"]',
        'button[aria-label="Search or start new chat"]',
        'div[aria-label="Search input textbox"]',
        'p.selectable-text.copyable-text',
      ],
      chatInputField: [
        'footer div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][data-tab="10"]',
        '#main footer div[contenteditable="true"]',
        'xpath://footer//div[@contenteditable="true"]',
      ],
      sendButton: [
        'button span[data-icon="send"]',
        'button[aria-label="Send"]',
        'span[data-icon="send"]',
        'xpath://button[contains(@aria-label, "Send")]',
      ],
      conversationDropZone: [
        '#main',
        'div[data-testid="conversation-panel-wrapper"]',
        'xpath://div[@id="main"]',
      ],
      // Direct assignment on this hidden input is tried before the drag-drop
      // simulation below — many sites (WhatsApp included, per reports) don't
      // reliably accept a synthetic DragEvent, since it isn't a real
      // OS-originated drag session. Setting .files directly and firing
      // 'change' is the more reliable technique automation tools use.
      mediaFileInput: [
        'input[type="file"][accept*="image"][accept*="video"]',
        'input[type="file"][accept^="image"]',
      ],
      mediaCaptionInput: [
        'div[aria-label="Add a caption"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[aria-placeholder="Add a caption"]',
        'xpath://div[@aria-label="Add a caption"]',
      ],
      attachButton: [
        'span[data-icon="plus-rounded"]',
        'span[data-icon="clip"]',
        'div[title="Attach"]',
        'button[title="Attach"]',
        'div[aria-label="Attach"]',
      ],
      documentMenuItem: [
        'li[data-testid="mi-attach-document"]',
        'div[aria-label="Document"]',
        'span[data-icon="document"]',
        'xpath://div[contains(text(), "Document")]',
        'xpath://li[contains(., "Document")]',
      ],
      // WhatsApp Web keeps a distinct hidden <input> per attach type — the
      // document one takes any file type, unlike the image/video one. NOT
      // falling back to a bare 'input[type="file"]' here on purpose: that
      // would risk silently grabbing the image/video input instead and
      // sending through the compressed path without telling anyone.
      documentFileInput: [
        'input[type="file"][accept="*"]',
        'input[type="file"]:not([accept*="image"])',
      ],
    };
  }

  /**
   * Returns { connected, reason }. reason is 'ready' | 'qr' | 'unknown' so
   * the panel can tell "not logged in yet" apart from "detection itself
   * failed" instead of collapsing both into a flat Disconnected.
   */
  async checkSessionState() {
    const hasQr = await this._quickCheck(this.SELECTORS.qrCode, 1500);
    if (hasQr) {
      return { connected: false, reason: 'qr' };
    }

    const loggedIn = await this._quickCheck(this.SELECTORS.loggedInAnchor, 6000);
    return loggedIn ? { connected: true, reason: 'ready' } : { connected: false, reason: 'unknown' };
  }

  async validateSession() {
    const { connected } = await this.checkSessionState();
    return connected;
  }

  async _quickCheck(selectors, timeoutMs) {
    try {
      await DOMSelectorEngine.resolveElement(selectors, timeoutMs);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Deep-link routing avoids complex DOM contact search steps, but setting
   * location.href always triggers a full page reload — even same-origin —
   * which destroys this script's JS context immediately. So this can only
   * ever navigate-and-return here; it cannot wait for the resulting chat to
   * load, because there is no "after" left to await in this instance. The
   * caller is responsible for resuming the task once the reloaded page's
   * fresh content script re-runs (see content-script.js's pending-task
   * handoff). Returns { navigated } so the caller knows which case applied.
   */
  async openConversation(phoneDigits) {
    const sanitizedNumber = phoneDigits.replace(/[^\d]/g, '');

    if (!window.location.href.includes(sanitizedNumber)) {
      window.location.href = `https://web.whatsapp.com/send?phone=${sanitizedNumber}`;
      return { navigated: true };
    }

    await DOMSelectorEngine.resolveElement(this.SELECTORS.chatInputField, 15000);
    return { navigated: false };
  }

  async injectPayload(textMessage) {
    const { node: inputNode } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.chatInputField,
      8000
    );
    await this._typeIntoField(inputNode, textMessage);
  }

  async triggerSend() {
    await this._clickSendButton(this.SELECTORS.sendButton, 5000);
  }

  /**
   * Drops a File onto the open conversation, waits for WhatsApp's media
   * preview/caption modal, types the caption into it, and sends.
   */
  async sendMediaWithCaption(file, captionText) {
    await this._dropFileIntoComposer(file);

    if (captionText) {
      const { node: captionNode } = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.mediaCaptionInput,
        8000
      );
      await this._typeIntoField(captionNode, captionText);
    }

    await this._clickSendButton(this.SELECTORS.sendButton, 8000);
  }

  /**
   * Sends a file through WhatsApp's "Document" attach path instead of
   * "Photos & videos" — WhatsApp re-encodes/compresses anything sent through
   * the latter, but passes documents through untouched. This is the most
   * speculative part of the adapter: it depends on WhatsApp's attach-menu
   * DOM, which isn't verifiable without a live session, so it's best-effort
   * and will need selector updates if WhatsApp changes that menu.
   */
  async sendAsDocument(file, captionText) {
    await this._attachAsDocument(file);

    if (captionText) {
      const { node: captionNode } = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.mediaCaptionInput,
        8000
      );
      await this._typeIntoField(captionNode, captionText);
    }

    await this._clickSendButton(this.SELECTORS.sendButton, 8000);
  }

  async _attachAsDocument(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    try {
      const { node: input } = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.documentFileInput,
        1500
      );
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    } catch (e) {
      // Fall through to the menu-driven path below.
    }

    const { node: attachBtn } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.attachButton,
      5000
    );
    attachBtn.click();

    const { node: documentItem } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.documentMenuItem,
      4000
    );
    documentItem.click();

    const { node: input } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.documentFileInput,
      4000
    );
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async _dropFileIntoComposer(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    try {
      const { node: input } = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.mediaFileInput,
        1500
      );
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    } catch (e) {
      // No matching hidden input found in time — fall back to simulating
      // an actual OS-style drag-and-drop onto the conversation panel.
    }

    const { node: dropTarget } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.conversationDropZone,
      8000
    );

    const dragEventSequence = ['dragenter', 'dragover', 'drop'];
    for (const eventName of dragEventSequence) {
      const event = new DragEvent(eventName, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropTarget.dispatchEvent(event);
      await new Promise((res) => setTimeout(res, 120));
    }
  }

  /**
   * Human-like typing simulation using InputEvent dispatches, shared by
   * both the plain chat composer and the media caption field.
   */
  async _typeIntoField(inputNode, text) {
    inputNode.focus();

    for (const character of text) {
      const inputEvent = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: character,
      });
      inputNode.dispatchEvent(inputEvent);

      // Execute native browser insertion command
      document.execCommand('insertText', false, character);

      // Random character delay variance (30ms - 90ms)
      const typingJitter = Math.floor(Math.random() * 60) + 30;
      await new Promise((res) => setTimeout(res, typingJitter));
    }

    inputNode.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async _clickSendButton(selectors, timeoutMs) {
    const { node: sendIcon } = await DOMSelectorEngine.resolveElement(selectors, timeoutMs);
    const targetButton = sendIcon.closest('button') || sendIcon;

    // Full Pointer and Mouse event simulation loop
    const eventSequence = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const eventName of eventSequence) {
      targetButton.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
      await new Promise((res) => setTimeout(res, 50));
    }
  }
}
