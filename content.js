(() => {
  "use strict";

  const EDITOR_SELECTOR = [
    "#prompt-textarea",
    "textarea[data-id='root']",
    "[contenteditable='true'][role='textbox']"
  ].join(",");

  const SEND_BUTTON_SELECTOR = "button[data-testid='send-button']";

  /**
   * Locate the ChatGPT composer without depending on generated CSS classes.
   *
   * @param {KeyboardEvent} event
   * @returns {HTMLElement | null}
   */
  function findComposerEditor(event) {
    const eventPath =
      typeof event.composedPath === "function"
        ? event.composedPath()
        : [event.target];

    for (const node of eventPath) {
      if (!(node instanceof Element)) {
        continue;
      }

      const editor = node.matches(EDITOR_SELECTOR)
        ? node
        : node.closest(EDITOR_SELECTOR);

      if (!(editor instanceof HTMLElement)) {
        continue;
      }

      if (editor.id === "prompt-textarea") {
        return editor;
      }

      const form = editor.closest("form");
      if (form?.querySelector(SEND_BUTTON_SELECTOR)) {
        return editor;
      }
    }

    return null;
  }

  /**
   * Dispatch an input event after a manual editor update.
   *
   * @param {HTMLElement} editor
   */
  function dispatchInputEvent(editor) {
    let inputEvent;

    try {
      inputEvent = new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertLineBreak",
        data: null
      });
    } catch {
      inputEvent = new Event("input", {
        bubbles: true,
        composed: true
      });
    }

    editor.dispatchEvent(inputEvent);
  }

  /**
   * Insert a newline into a textarea while preserving its selection.
   *
   * @param {HTMLTextAreaElement} editor
   */
  function insertTextareaLineBreak(editor) {
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;

    editor.setRangeText("\n", start, end, "end");
    dispatchInputEvent(editor);
  }

  /**
   * Fallback for contenteditable editors where execCommand is unavailable.
   *
   * @param {HTMLElement} editor
   */
  function insertContentEditableLineBreakFallback(editor) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    if (
      selection.rangeCount === 0 ||
      !editor.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      const endRange = document.createRange();
      endRange.selectNodeContents(editor);
      endRange.collapse(false);
      selection.removeAllRanges();
      selection.addRange(endRange);
    }

    const range = selection.getRangeAt(0);
    const lineBreak = document.createElement("br");

    range.deleteContents();
    range.insertNode(lineBreak);
    range.setStartAfter(lineBreak);
    range.collapse(true);

    selection.removeAllRanges();
    selection.addRange(range);
    dispatchInputEvent(editor);
  }

  /**
   * Insert a newline and notify ChatGPT's editor state.
   *
   * @param {HTMLElement} editor
   */
  function insertLineBreak(editor) {
    editor.focus();

    if (editor instanceof HTMLTextAreaElement) {
      insertTextareaLineBreak(editor);
      return;
    }

    if (document.execCommand("insertLineBreak", false)) {
      return;
    }

    insertContentEditableLineBreakFallback(editor);
  }

  /**
   * Click the send button belonging to the active composer.
   *
   * @param {HTMLElement} editor
   */
  function sendMessage(editor) {
    const form = editor.closest("form");
    const sendButton =
      form?.querySelector(SEND_BUTTON_SELECTOR) ??
      document.querySelector(SEND_BUTTON_SELECTOR);

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
    // handler and insert a newline instead.
    event.preventDefault();
    event.stopImmediatePropagation();
    insertLineBreak(editor);
  }

  document.addEventListener("keydown", handleKeydown, true);
})();
