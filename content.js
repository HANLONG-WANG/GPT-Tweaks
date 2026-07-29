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
  const LIST_INDENT = "    ";
  const SEND_BUTTON_SELECTOR = "button[data-testid='send-button']";
  const PENDING_LIST_EXITS = new WeakMap();
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
   * Read all editor text before a collapsed caret.
   *
   * @param {HTMLElement} editor
   * @returns {string | null}
   */
  function getEditorTextBeforeCaret(editor) {
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

    return textBeforeCaret;
  }

  /**
   * Read the current visual line up to a collapsed caret.
   *
   * @param {HTMLElement} editor
   * @returns {string | null}
   */
  function getCurrentLineBeforeCaret(editor) {
    const textBeforeCaret = getEditorTextBeforeCaret(editor);

    return textBeforeCaret === null
      ? null
      : textBeforeCaret.split("\n").at(-1) ?? "";
  }

  /**
   * Parse a Markdown-style list item and calculate its next marker.
   *
   * @param {string} line
   * @returns {{
   *   type: "ordered" | "unordered",
   *   indent: string,
   *   marker: string,
   *   markerSuffix: string,
   *   number: number | null,
   *   prefix: string,
   *   nextPrefix: string,
   *   content: string
   * } | null}
   */
  function parseListItem(line) {
    const unorderedItem = line.match(
      /^([ \t]*)(-[ \t]+)(.*)$/
    );

    if (unorderedItem) {
      return {
        type: "unordered",
        indent: unorderedItem[1],
        marker: unorderedItem[2],
        markerSuffix: "",
        number: null,
        prefix: unorderedItem[1] + unorderedItem[2],
        nextPrefix: unorderedItem[1] + unorderedItem[2],
        content: unorderedItem[3]
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
      type: "ordered",
      indent: orderedItem[1],
      marker: orderedItem.slice(2, 5).join(""),
      markerSuffix: orderedItem[3] + orderedItem[4],
      number: currentNumber,
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
   * Count the caret movements required to cross a string without splitting
   * surrogate pairs or combined characters.
   *
   * @param {string} text
   * @returns {number}
   */
  function countCaretCharacters(text) {
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme"
      });

      return [...segmenter.segment(text)].length;
    }

    return [...text].length;
  }

  /**
   * Return the rendered width of Markdown indentation.
   *
   * @param {string} indent
   * @returns {number}
   */
  function getIndentWidth(indent) {
    return [...indent].reduce(
      (width, character) =>
        width +
        (character === "\t" ? LIST_INDENT.length : 1),
      0
    );
  }

  /**
   * Return the first indentation level that Shift+Tab should remove.
   *
   * @param {string} indent
   * @returns {string}
   */
  function getIndentationToRemove(indent) {
    if (indent.startsWith("\t")) {
      return "\t";
    }

    const leadingSpaces = indent.match(/^ +/)?.[0] ?? "";
    return leadingSpaces.slice(0, LIST_INDENT.length);
  }

  /**
   * Build a list prefix at a requested indentation and ordered-list number.
   *
   * @param {ReturnType<typeof parseListItem>} listItem
   * @param {string} indent
   * @param {number | null} [orderedNumber]
   * @returns {string}
   */
  function buildListPrefix(
    listItem,
    indent,
    orderedNumber = listItem?.number ?? null
  ) {
    if (!listItem) {
      return "";
    }

    if (listItem.type === "unordered") {
      return indent + listItem.marker;
    }

    return (
      indent +
      String(orderedNumber ?? 1) +
      listItem.markerSuffix
    );
  }

  /**
   * Return complete lines before the line containing the caret.
   *
   * @param {HTMLElement} editor
   * @returns {string[] | null}
   */
  function getLinesBeforeCurrentLine(editor) {
    const textBeforeCaret = getEditorTextBeforeCaret(editor);
    if (textBeforeCaret === null) {
      return null;
    }

    const lines = textBeforeCaret.split("\n");
    lines.pop();
    return lines;
  }

  /**
   * Find the nearest preceding list item at an exact indentation level.
   * Deeper child items are skipped, while shallower content ends the search.
   *
   * @param {string[]} lines
   * @param {string} targetIndent
   * @returns {ReturnType<typeof parseListItem>}
   */
  function findPreviousListItemAtIndent(lines, targetIndent) {
    const targetWidth = getIndentWidth(targetIndent);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line.trim() === "") {
        return null;
      }

      const listItem = parseListItem(line);
      if (listItem) {
        const itemWidth = getIndentWidth(listItem.indent);

        if (itemWidth > targetWidth) {
          continue;
        }

        return itemWidth === targetWidth ? listItem : null;
      }

      const lineIndent = line.match(/^[ \t]*/)?.[0] ?? "";
      if (getIndentWidth(lineIndent) <= targetWidth) {
        return null;
      }
    }

    return null;
  }

  /**
   * Continue the nearest preceding ordered list at an indentation level.
   *
   * @param {string[]} lines
   * @param {string} targetIndent
   * @returns {number}
   */
  function getNextOrderedNumber(lines, targetIndent) {
    const previousItem =
      findPreviousListItemAtIndent(lines, targetIndent);

    if (
      previousItem?.type !== "ordered" ||
      previousItem.number === null ||
      previousItem.number >= Number.MAX_SAFE_INTEGER
    ) {
      return 1;
    }

    return previousItem.number + 1;
  }

  /**
   * Replace the list prefix on the current line and preserve the caret's
   * position relative to the item content.
   *
   * @param {HTMLElement} editor
   * @param {string} currentLine
   * @param {string} oldPrefix
   * @param {string} newPrefix
   * @returns {boolean}
   */
  function replaceCurrentLinePrefix(
    editor,
    currentLine,
    oldPrefix,
    newPrefix
  ) {
    const selection = window.getSelection();
    if (
      !selection ||
      !selection.isCollapsed ||
      selection.rangeCount === 0 ||
      typeof selection.modify !== "function"
    ) {
      return false;
    }

    const lineCharacterCount =
      countCaretCharacters(currentLine);
    const oldPrefixCharacterCount =
      countCaretCharacters(oldPrefix);
    const contentCharacterCount = Math.max(
      0,
      lineCharacterCount - oldPrefixCharacterCount
    );

    editor.focus();

    for (
      let index = 0;
      index < lineCharacterCount;
      index += 1
    ) {
      selection.modify("move", "backward", "character");
    }

    for (
      let index = 0;
      index < oldPrefixCharacterCount;
      index += 1
    ) {
      selection.modify("extend", "forward", "character");
    }

    insertTextAtCaret(editor, newPrefix);

    for (
      let index = 0;
      index < contentCharacterCount;
      index += 1
    ) {
      selection.modify("move", "forward", "character");
    }

    return true;
  }

  /**
   * Insert one Markdown indentation level before the current list item.
   *
   * @param {HTMLElement} editor
   * @returns {boolean}
   */
  function indentCurrentListItem(editor) {
    const currentLine = getCurrentLineBeforeCaret(editor);
    const listItem =
      currentLine === null ? null : parseListItem(currentLine);
    const selection = window.getSelection();

    if (
      !listItem ||
      !selection ||
      !selection.isCollapsed ||
      selection.rangeCount === 0 ||
      typeof selection.modify !== "function"
    ) {
      return false;
    }

    const targetIndent = LIST_INDENT + listItem.indent;
    const targetNumber =
      listItem.type === "ordered" ? 1 : null;
    const newPrefix = buildListPrefix(
      listItem,
      targetIndent,
      targetNumber
    );

    return replaceCurrentLinePrefix(
      editor,
      currentLine,
      listItem.prefix,
      newPrefix
    );
  }

  /**
   * Remove one Markdown indentation level before the current list item.
   *
   * @param {HTMLElement} editor
   * @returns {boolean}
   */
  function outdentCurrentListItem(editor) {
    const currentLine = getCurrentLineBeforeCaret(editor);
    const listItem =
      currentLine === null ? null : parseListItem(currentLine);
    const selection = window.getSelection();

    if (
      !listItem ||
      !selection ||
      !selection.isCollapsed ||
      selection.rangeCount === 0 ||
      typeof selection.modify !== "function"
    ) {
      return false;
    }

    const indentationToRemove =
      getIndentationToRemove(listItem.indent);

    if (!indentationToRemove) {
      return false;
    }

    const targetIndent = listItem.indent.slice(
      indentationToRemove.length
    );
    const precedingLines =
      getLinesBeforeCurrentLine(editor) ?? [];
    const targetNumber =
      listItem.type === "ordered"
        ? getNextOrderedNumber(precedingLines, targetIndent)
        : null;
    const newPrefix = buildListPrefix(
      listItem,
      targetIndent,
      targetNumber
    );

    return replaceCurrentLinePrefix(
      editor,
      currentLine,
      listItem.prefix,
      newPrefix
    );
  }

  /**
   * Build the parent-level prefix used after leaving an empty nested item.
   *
   * @param {ReturnType<typeof parseListItem>} listItem
   * @param {string[]} precedingLines
   * @returns {{ remainingIndent: string, parentPrefix: string } | null}
   */
  function buildPendingListExit(listItem, precedingLines) {
    if (!listItem?.indent) {
      return null;
    }

    const indentationToRemove =
      getIndentationToRemove(listItem.indent);
    if (!indentationToRemove) {
      return null;
    }

    const parentIndent = listItem.indent.slice(
      indentationToRemove.length
    );
    const previousParent =
      findPreviousListItemAtIndent(
        precedingLines,
        parentIndent
      );
    const parentTemplate = previousParent ?? listItem;
    const parentNumber =
      parentTemplate.type === "ordered"
        ? getNextOrderedNumber(precedingLines, parentIndent)
        : null;

    return {
      remainingIndent: listItem.indent,
      parentPrefix: buildListPrefix(
        parentTemplate,
        parentIndent,
        parentNumber
      )
    };
  }

  /**
   * Restore the parent list marker on the same line after the first Enter
   * removed an empty nested marker.
   *
   * @param {HTMLElement} editor
   * @param {string} currentLine
   * @returns {boolean}
   */
  function handlePendingListExit(editor, currentLine) {
    const pendingExit = PENDING_LIST_EXITS.get(editor);
    if (!pendingExit) {
      return false;
    }

    PENDING_LIST_EXITS.delete(editor);

    if (currentLine !== pendingExit.remainingIndent) {
      return false;
    }

    return replaceCurrentLinePrefix(
      editor,
      currentLine,
      currentLine,
      pendingExit.parentPrefix
    );
  }

  /**
   * Continue a list item or progressively leave an empty nested list.
   *
   * @param {HTMLElement} editor
   * @param {KeyboardEvent} sourceEvent
   * @returns {boolean}
   */
  function handleListLineBreak(editor, sourceEvent) {
    const currentLine = getCurrentLineBeforeCaret(editor);
    if (currentLine === null) {
      return false;
    }

    if (handlePendingListExit(editor, currentLine)) {
      return true;
    }

    const listItem = parseListItem(currentLine);
    if (!listItem) {
      return false;
    }

    if (listItem.content.trim() === "") {
      const precedingLines =
        getLinesBeforeCurrentLine(editor) ?? [];
      const pendingExit =
        buildPendingListExit(listItem, precedingLines);
      const markerLength =
        listItem.prefix.length - listItem.indent.length;

      removeTextBeforeCaret(editor, markerLength);

      if (pendingExit) {
        PENDING_LIST_EXITS.set(editor, pendingExit);
      } else {
        PENDING_LIST_EXITS.delete(editor);
      }

      return true;
    }

    PENDING_LIST_EXITS.delete(editor);
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
   * Cancel a pending nested-list exit after any intervening editor input.
   *
   * @param {InputEvent} event
   */
  function handleEditorInput(event) {
    const editor = findComposerEditor(event);
    if (editor) {
      PENDING_LIST_EXITS.delete(editor);
    }
  }

  /**
   * Change ChatGPT's keyboard behavior at the capture phase, before the
   * application receives the keydown event.
   *
   * @param {KeyboardEvent} event
   */
  function handleKeydown(event) {
    if (REDISPATCHED_EVENTS.has(event)) {
      return;
    }

    const editor = findComposerEditor(event);
    if (!editor) {
      return;
    }

    const isPlainEnterKey =
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;

    if (!isPlainEnterKey) {
      PENDING_LIST_EXITS.delete(editor);
    }

    if (
      (event.key !== "Enter" && event.key !== "Tab") ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (
        !event.repeat &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (event.shiftKey) {
          outdentCurrentListItem(editor);
        } else {
          indentCurrentListItem(editor);
        }
      }

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

  document.addEventListener("input", handleEditorInput, true);
  document.addEventListener("keydown", handleKeydown, true);
})();
