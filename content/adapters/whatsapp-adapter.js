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
      searchInput: [
        'div[contenteditable="true"][data-tab="3"]',
        'p.selectable-text.copyable-text',
        '#side div[contenteditable="true"]',
        'xpath://div[@contenteditable="true"][@data-tab="3"]',
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
      mediaCaptionInput: [
        'div[aria-label="Add a caption"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[aria-placeholder="Add a caption"]',
        'xpath://div[@aria-label="Add a caption"]',
      ],
    };
  }

  async validateSession() {
    try {
      await DOMSelectorEngine.resolveElement(this.SELECTORS.searchInput, 5000);
      return true;
    } catch (e) {
      return false;
    }
  }

  async openConversation(phoneDigits) {
    const sanitizedNumber = phoneDigits.replace(/[^\d]/g, '');
    const directURI = `https://web.whatsapp.com/send?phone=${sanitizedNumber}`;

    // Deep-link routing avoids complex DOM contact search steps
    if (!window.location.href.includes(sanitizedNumber)) {
      window.location.href = directURI;
      await DOMSelectorEngine.resolveElement(this.SELECTORS.chatInputField, 15000);
    }
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

  async _dropFileIntoComposer(file) {
    const { node: dropTarget } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.conversationDropZone,
      8000
    );

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

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
