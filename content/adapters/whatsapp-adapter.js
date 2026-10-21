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
        'div[data-testid="send"]',
        'span[data-icon="send"]',
        'span[data-icon="wds-ic-send"]',
        'span[data-icon="send-light"]',
        'span[data-icon="send-inverted"]',
        'button span[data-icon="send"]',
        'button span[data-icon="wds-ic-send"]',
        'button[aria-label="Send"]',
        'div[role="button"][aria-label="Send"]',
        'div[aria-label="Send"]',
        'div[role="button"] span[data-icon="send"]',
        'div[role="button"] span[data-icon="wds-ic-send"]',
        'xpath://span[@data-icon="send" or @data-icon="wds-ic-send" or @data-icon="send-light"]/ancestor::div[@role="button"]',
        'xpath://span[@data-icon="send" or @data-icon="wds-ic-send" or @data-icon="send-light"]/ancestor::button',
        'xpath://button[contains(@aria-label, "Send")]',
        'xpath://div[@role="button" and contains(@aria-label, "Send")]',
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
      // Deliberately does NOT include the bare chat-box selector
      // ('div[contenteditable="true"][data-tab="10"]') as a fallback here —
      // that selector also matches chatInputField. If the media modal fails
      // to open (e.g. the drag-drop simulation below didn't register), a
      // shared fallback would silently resolve to the plain chat box
      // instead, typing the caption there and sending it as a normal text
      // message with no error — exactly the "sends text instead of photo"
      // failure mode this list must not reintroduce.
      mediaCaptionInput: [
        'div[aria-label="Add a caption"]',
        'div[aria-placeholder="Add a caption"]',
        'xpath://div[@aria-label="Add a caption"]',
      ],
      attachButton: [
        'footer button[title="Attach"]',
        'footer button[aria-label="Attach"]',
        'footer div[title="Attach"]',
        'footer div[aria-label="Attach"]',
        'footer span[data-icon="plus"]',
        'footer span[data-icon="plus-rounded"]',
        'footer span[data-icon="attach-menu-plus"]',
        'footer span[data-icon="clip"]',
        '#main footer button[title="Attach"]',
        'button[title="Attach"]',
        'div[title="Attach"]',
        'button[aria-label="Attach"]',
        'div[aria-label="Attach"]',
        'span[data-icon="plus"]',
        'span[data-icon="plus-rounded"]',
        'span[data-icon="attach-menu-plus"]',
        'span[data-icon="clip"]',
      ],
      documentMenuItem: [
        'li[data-testid="mi-attach-document"]',
        'button[aria-label="Document"]',
        'div[aria-label="Document"]',
        'span[data-icon="document"]',
        'span[data-icon="attach-document"]',
        'xpath://div[contains(text(), "Document")]',
        'xpath://li[contains(., "Document")]',
        'xpath://span[contains(@data-icon, "document")]/ancestor::button',
        'xpath://span[contains(@data-icon, "document")]/ancestor::li',
      ],
      // WhatsApp Web keeps a distinct hidden <input> per attach type — the
      // document one takes any file type, unlike the image/video one.
      documentFileInput: [
        'li[data-testid="mi-attach-document"] input[type="file"]',
        'input[type="file"][accept="*"]',
        'input[type="file"][accept*="pdf"]',
        'input[type="file"]:not([accept*="image"]):not([accept*="video"])',
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

    // Resolving the caption box (even when there's no caption to type)
    // is the confirmation that WhatsApp's media preview modal actually
    // opened. Skipping this when captionText is empty would let a failed
    // drop go undetected and fall through to clicking whatever "Send"
    // button is currently on screen — which, with no modal open, is the
    // plain chat send button.
    const { node: captionNode } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.mediaCaptionInput,
      8000
    );
    if (captionText) {
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

    // Wait for the document preview modal (caption input or modal send button)
    let captionNode = null;
    let typedCaption = false;
    try {
      const res = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.mediaCaptionInput,
        3500
      );
      captionNode = res.node;
    } catch (e) {
      // Caption input optional on some WhatsApp document previews
    }

    if (captionText && captionNode) {
      await this._typeIntoField(captionNode, captionText);
      typedCaption = true;
      await new Promise((res) => setTimeout(res, 200));
    }

    await this._clickSendButton(this.SELECTORS.sendButton, 10000);
    await new Promise((res) => setTimeout(res, 1200));

    // If message text was not typed into the modal caption, deliver it as follow-up
    if (captionText && !typedCaption) {
      try {
        await this.injectPayload(captionText);
        await this.triggerSend();
      } catch (e) {
        console.warn('[Outreach] Follow-up text send after document failed:', e);
      }
    }
  }

  async _attachAsDocument(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const setInputFiles = (inputElem) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (descriptor && descriptor.set) {
          descriptor.set.call(inputElem, dataTransfer.files);
        } else {
          inputElem.files = dataTransfer.files;
        }
      } catch (e) {
        inputElem.files = dataTransfer.files;
      }
      inputElem.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      inputElem.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };

    const isModalOpen = () => Boolean(document.querySelector(
      'div[aria-label="Add a caption"], ' +
      'div[aria-placeholder="Add a caption"], ' +
      'div[data-testid="media-caption-input-container"], ' +
      'div[data-testid="send"], ' +
      'span[data-icon="send"], ' +
      'span[data-icon="wds-ic-send"], ' +
      'span[data-icon="send-light"], ' +
      'div[role="button"][aria-label="Send"]'
    ));

    // Filter helper: find a file input that does NOT restrict to images/videos
    const findDocInput = () => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.find((input) => {
        const accept = (input.getAttribute('accept') || '').toLowerCase();
        return accept === '*' || accept === '*/*' || (accept && !accept.includes('image') && !accept.includes('video')) || !accept;
      });
    };

    // 1. Check if a non-image file input is already in the DOM
    let docInput = findDocInput();
    if (docInput) {
      setInputFiles(docInput);
      await new Promise((res) => setTimeout(res, 800));
      if (isModalOpen()) return;
    }

    // 2. Open Attach menu to reveal Document menu item & input
    try {
      const { node: attachIcon } = await DOMSelectorEngine.resolveElement(
        this.SELECTORS.attachButton,
        3500
      );
      const attachClickable = attachIcon.closest('button') || attachIcon.closest('div[role="button"]') || attachIcon;

      // Dispatch full mouse click sequence on the button element
      const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const ev of events) {
        attachClickable.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      }
      if (typeof attachClickable.click === 'function') {
        attachClickable.click();
      }
      await new Promise((res) => setTimeout(res, 400));

      // Check again for document file input revealed by open menu
      docInput = findDocInput();
      if (docInput) {
        setInputFiles(docInput);
        await new Promise((res) => setTimeout(res, 800));
        if (isModalOpen()) return;
      }

      // Try finding input inside document menu item
      const docItem = document.querySelector(
        'li[data-testid="mi-attach-document"], ' +
        'span[data-icon="document"], ' +
        'span[data-icon="attach-document"]'
      )?.closest('li') || document.querySelector('span[data-icon="document"], span[data-icon="attach-document"]')?.closest('button');

      if (docItem) {
        const itemInput = docItem.querySelector('input[type="file"]') || docItem.parentElement?.querySelector('input[type="file"]');
        if (itemInput) {
          setInputFiles(itemInput);
          await new Promise((res) => setTimeout(res, 800));
          if (isModalOpen()) return;
        }
      }
    } catch (e) {
      // Menu interaction failed, proceed to direct drop
    }

    // 3. Fallback: simulate native HTML5 drag-and-drop onto chat area & composer
    await this._simulateFileDrop(file);
    await new Promise((res) => setTimeout(res, 1200));
  }

  async _simulateFileDrop(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const targets = [
      document.querySelector('#main footer div[contenteditable="true"]'),
      document.querySelector('div[contenteditable="true"][data-tab="10"]'),
      document.querySelector('#main'),
      document.querySelector('div[data-testid="conversation-panel-wrapper"]'),
      document.body,
    ].filter(Boolean);

    for (const target of targets) {
      for (const eventName of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(eventName, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        });
        target.dispatchEvent(event);
      }
      await new Promise((res) => setTimeout(res, 100));
      if (document.querySelector('div[aria-label="Add a caption"], div[data-testid="send"], span[data-icon="send"], span[data-icon="wds-ic-send"], span[data-icon="send-light"]')) {
        return true;
      }
    }
    return false;
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
      await new Promise((res) => setTimeout(res, 800));
      return;
    } catch (e) {
      // Fall through to drag-drop simulation
    }

    await this._simulateFileDrop(file);
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
    const targetButton = sendIcon.closest('button') || sendIcon.closest('div[role="button"]') || sendIcon.parentElement || sendIcon;

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
      await new Promise((res) => setTimeout(res, 40));
    }

    // Call native .click() to ensure element activation
    if (typeof targetButton.click === 'function') {
      try {
        targetButton.click();
      } catch (e) {}
    }
  }
}
