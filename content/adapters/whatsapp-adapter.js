import { MessagingAdapter } from './base-adapter.js';
import { DOMSelectorEngine } from '../dom-selector-engine.js';

/**
 * Concrete WhatsApp Web Messaging Adapter Implementation.
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

    inputNode.focus();

    // Human-like typing simulation using InputEvent dispatches
    for (const character of textMessage) {
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

  async triggerSend() {
    const { node: sendIcon } = await DOMSelectorEngine.resolveElement(
      this.SELECTORS.sendButton,
      5000
    );

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
