/**
 * Abstract Class: MessagingAdapter
 * Defines the mandatory contract every platform-specific adapter must
 * implement so the queue engine can drive any messaging surface uniformly.
 */
export class MessagingAdapter {
  constructor() {
    if (this.constructor === MessagingAdapter) {
      throw new Error('Abstract classes cannot be instantiated directly.');
    }
  }

  async validateSession() {
    throw new Error('Method validateSession() required.');
  }

  async openConversation(recipientId) {
    throw new Error('Method openConversation() required.');
  }

  async injectPayload(messageText) {
    throw new Error('Method injectPayload() required.');
  }

  async triggerSend() {
    throw new Error('Method triggerSend() required.');
  }
}
