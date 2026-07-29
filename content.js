(() => {
  "use strict";

  const SEND_BUTTON_SELECTOR = "button[data-testid='send-button']";
  const REDISPATCHED_EVENTS = new WeakSet();

  /**
   * Locate the ChatGPT composer without depending on generated CSS classes.
   *
   * @param {KeyboardEvent} event
   * @returns {HTMLElement | null}
   */
  function findComposerEditor(event) {
    if (!(event.target instanceof Element)) {
      return null;
    }

    return event.target.closest("#prompt-textarea");
  }

  /**
   * Re-dispatch Enter as Shift+Enter so ChatGPT's own editor performs its
   * native newline action. This avoids mutating ProseMirror's DOM directly.
   *
   * @param {HTMLElement} editor
   * @param {KeyboardEvent} sourceEvent
   */
  function dispatchNativeLineBreak(editor, sourceEvent) {
    const shiftEnterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      code: sourceEvent.code || "Enter",
      location: sourceEvent.location,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: true,
      repeat: sourceEvent.repeat
    });

    REDISPATCHED_EVENTS.add(shiftEnterEvent);
    editor.dispatchEvent(shiftEnterEvent);
  }

  /**
   * Click the send button belonging to the active composer.
   *
   * @param {HTMLElement} editor
   */
  function sendMessage(editor) {
    const form = editor.closest("form");
    const sendButton = form?.querySelector(SEND_BUTTON_SELECTOR);

    if (
      !(sendButton instanceof HTMLButtonElement) ||
      sendButton.disabled ||
      sendButton.getAttribute("aria-disabled") === "true"
    ) {
      return;
    }

    sendButton.click();
  }

  /**
   * Change ChatGPT's keyboard behavior at the capture phase, before the
   * application receives the keydown event.
   *
   * @param {KeyboardEvent} event
   */
  function handleKeydown(event) {
    if (
      REDISPATCHED_EVENTS.has(event) ||
      event.key !== "Enter" ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }

    const editor = findComposerEditor(event);
    if (!editor) {
      return;
    }

    const isSendShortcut =
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey;

    if (isSendShortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!event.repeat) {
        sendMessage(editor);
      }

      return;
    }

    // ChatGPT already treats Shift+Enter as a newline, so leave it native.
    if (event.shiftKey) {
      return;
    }

    // Block every other Enter combination from reaching ChatGPT's send
    // handler, then reuse ChatGPT's native Shift+Enter newline behavior.
    event.preventDefault();
    event.stopImmediatePropagation();
    dispatchNativeLineBreak(editor, event);
  }

  document.addEventListener("keydown", handleKeydown, true);
})();
