(() => {
  "use strict";

  const BLOCK_TAGS = new Set([
    "BLOCKQUOTE",
    "DIV",
    "LI",
    "OL",
    "P",
    "PRE",
    "UL"
  ]);
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
   * Convert the editor DOM before the caret to plain text while preserving
   * hard breaks and block boundaries.
   *
   * @param {Node} parent
   * @returns {string}
   */
  function readEditorText(parent) {
    let text = "";

    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue ?? "";
        continue;
      }

      if (!(node instanceof Element)) {
        continue;
      }

      if (node.tagName === "BR") {
        text += "\n";
        continue;
      }

      if (
        BLOCK_TAGS.has(node.tagName) &&
        text.length > 0 &&
        !text.endsWith("\n")
      ) {
        text += "\n";
      }

      text += readEditorText(node);
    }

    return text;
  }

  /**
   * Read the current visual line up to a collapsed caret.
   *
   * @param {HTMLElement} editor
   * @returns {string | null}
   */
  function getCurrentLineBeforeCaret(editor) {
    const selection = window.getSelection();

    if (
      !selection ||
      !selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !editor.contains(selection.anchorNode)
    ) {
      return null;
    }

    const caretRange = selection.getRangeAt(0);
    const precedingRange = document.createRange();
    precedingRange.selectNodeContents(editor);
    precedingRange.setEnd(caretRange.endContainer, caretRange.endOffset);

    const textBeforeCaret = readEditorText(
      precedingRange.cloneContents()
    );

    return textBeforeCaret.split("\n").at(-1) ?? "";
  }

  /**
   * Parse a Markdown-style list item and calculate its next marker.
   *
   * @param {string} line
   * @returns {{ prefix: string, nextPrefix: string, content: string } | null}
   */
  function parseListItem(line) {
    const unorderedItem = line.match(
      /^([ \t]*-[ \t]+)(.*)$/
    );

    if (unorderedItem) {
      return {
        prefix: unorderedItem[1],
        nextPrefix: unorderedItem[1],
        content: unorderedItem[2]
      };
    }

    const orderedItem = line.match(
      /^([ \t]*)(\d+)(\.)([ \t]+)(.*)$/
    );

    if (!orderedItem) {
      return null;
    }

    const currentNumber = Number.parseInt(orderedItem[2], 10);
    if (!Number.isSafeInteger(currentNumber)) {
      return null;
    }

    return {
      prefix: orderedItem.slice(1, 5).join(""),
      nextPrefix:
        orderedItem[1] +
        String(currentNumber + 1) +
        orderedItem[3] +
        orderedItem[4],
      content: orderedItem[5]
    };
  }

  /**
   * Insert plain text at the current caret and let ProseMirror observe it.
   *
   * @param {HTMLElement} editor
   * @param {string} text
   */
  function insertTextAtCaret(editor, text) {
    editor.focus();

    if (document.execCommand("insertText", false, text)) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const textNode = document.createTextNode(text);
    range.deleteContents();
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text
      })
    );
  }

  /**
   * Remove an automatically generated list marker before the caret.
   *
   * @param {HTMLElement} editor
   * @param {number} characterCount
   */
  function removeTextBeforeCaret(editor, characterCount) {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      typeof selection.modify !== "function"
    ) {
      return;
    }

    editor.focus();

    for (let index = 0; index < characterCount; index += 1) {
      selection.modify("extend", "backward", "character");
    }

    if (document.execCommand("delete", false)) {
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteContentBackward",
        data: null
      })
    );
  }

  /**
   * Continue a list item or remove an empty marker to leave the list.
   *
   * @param {HTMLElement} editor
   * @param {KeyboardEvent} sourceEvent
   * @returns {boolean}
   */
  function handleListLineBreak(editor, sourceEvent) {
    const currentLine = getCurrentLineBeforeCaret(editor);
    const listItem =
      currentLine === null ? null : parseListItem(currentLine);

    if (!listItem) {
      return false;
    }

    if (listItem.content.trim() === "") {
      removeTextBeforeCaret(editor, listItem.prefix.length);
      return true;
    }

    dispatchNativeLineBreak(editor, sourceEvent);
    insertTextAtCaret(editor, listItem.nextPrefix);
    return true;
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

    const isPlainEnter =
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey;

    if (isPlainEnter && handleListLineBreak(editor, event)) {
      return;
    }

    dispatchNativeLineBreak(editor, event);
  }

  document.addEventListener("keydown", handleKeydown, true);
})();
