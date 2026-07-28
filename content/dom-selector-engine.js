/**
 * Robust DOM Selector Engine with Fallback & Mutation Retries.
 * Shared across platform adapters so selector resilience logic isn't
 * duplicated per messaging surface.
 */
export class DOMSelectorEngine {
  /**
   * Evaluates an array of fallback selectors sequentially until a matching
   * element is resolved. Supports plain CSS selectors and 'xpath:' prefixed
   * XPath expressions.
   *
   * Resolution is driven by a MutationObserver watching the document for
   * subtree/attribute changes so slow re-renders (React/virtual-DOM diffs
   * on WhatsApp Web) resolve as soon as the target node appears, instead of
   * waiting for the next fixed poll tick. A 200ms poll still runs alongside
   * as a fallback for cases the observer doesn't catch (e.g. style-only
   * visibility flips with no attribute mutation recorded).
   */
  static resolveElement(selectors, timeoutMs = 12000, contextNode = document) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let settled = false;

      const tryResolve = () => {
        if (settled) return;

        for (const selector of selectors) {
          let matchedNode = null;

          if (selector.startsWith('xpath:')) {
            const rawXPath = selector.replace('xpath:', '');
            const result = document.evaluate(
              rawXPath,
              contextNode,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            matchedNode = result.singleNodeValue;
          } else {
            matchedNode = contextNode.querySelector(selector);
          }

          if (matchedNode && this.isInteractable(matchedNode)) {
            settle(() => resolve({ node: matchedNode, successfulSelector: selector }));
            return;
          }
        }

        if (Date.now() - startTime >= timeoutMs) {
          settle(() =>
            reject(
              new Error(
                `DOM Resolution Timeout: Unable to locate element matching candidate set [${selectors.join(', ')}]`
              )
            )
          );
        }
      };

      const observer = new MutationObserver(tryResolve);
      const pollHandle = setInterval(tryResolve, 200);

      function settle(action) {
        settled = true;
        observer.disconnect();
        clearInterval(pollHandle);
        action();
      }

      observer.observe(contextNode === document ? document.documentElement : contextNode, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      tryResolve();
    });
  }

  static isInteractable(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  }
}
