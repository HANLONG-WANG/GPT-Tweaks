(() => {
  "use strict";

  const DATA_EVENT = "gpt-tweaks:conversation-data";
  const CONVERSATION_URL_PATTERN =
    /\/backend-api\/conversation\/([^/?#]+)/;
  const originalFetch = window.fetch;

  /**
   * Convert the user-visible portion of a message into a compact label.
   *
   * @param {unknown} content
   * @returns {string}
   */
  function readMessageLabel(content) {
    if (!content || typeof content !== "object") {
      return "";
    }

    const parts = Array.isArray(content.parts)
      ? content.parts
      : [];
    const text = parts
      .map(part => {
        if (typeof part === "string") {
          return part;
        }

        if (
          part &&
          typeof part === "object" &&
          typeof part.text === "string"
        ) {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text) {
      const characters = [...text];

      return characters.length > 200
        ? `${characters.slice(0, 197).join("")}...`
        : text;
    }

    return parts.length > 0 ? "Image upload" : "";
  }

  /**
   * Publish only the metadata required by the navigator. Message bodies from
   * assistant, tool and system nodes never leave the page's main world.
   *
   * @param {unknown} payload
   * @param {string} requestUrl
   */
  function publishConversationData(payload, requestUrl) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const conversation =
      payload.mapping && typeof payload.mapping === "object"
        ? payload
        : payload.conversation;

    if (
      !conversation ||
      typeof conversation !== "object" ||
      !conversation.mapping ||
      typeof conversation.mapping !== "object"
    ) {
      return;
    }

    const requestConversationId =
      requestUrl.match(CONVERSATION_URL_PATTERN)?.[1] ?? "";
    const nodes = Object.values(conversation.mapping)
      .filter(node => node && typeof node === "object")
      .map(node => {
        const message =
          node.message && typeof node.message === "object"
            ? node.message
            : null;
        const role =
          message?.author &&
          typeof message.author === "object" &&
          typeof message.author.role === "string"
            ? message.author.role
            : "";

        return {
          id: typeof node.id === "string" ? node.id : "",
          parent:
            typeof node.parent === "string" ? node.parent : null,
          role,
          messageId:
            typeof message?.id === "string" ? message.id : "",
          label:
            role === "user"
              ? readMessageLabel(message?.content)
              : ""
        };
      })
      .filter(node => node.id);

    const detail = JSON.stringify({
      conversationId:
        typeof conversation.conversation_id === "string"
          ? conversation.conversation_id
          : requestConversationId,
      currentNode:
        typeof conversation.current_node === "string"
          ? conversation.current_node
          : null,
      nodes
    });

    window.dispatchEvent(
      new CustomEvent(DATA_EVENT, {detail})
    );
  }

  /**
   * Inspect a clone without delaying or consuming ChatGPT's response.
   *
   * @param {Response} response
   * @param {string} requestUrl
   */
  function inspectResponse(response, requestUrl) {
    if (
      !response.ok ||
      !CONVERSATION_URL_PATTERN.test(requestUrl)
    ) {
      return;
    }

    response
      .clone()
      .json()
      .then(payload => {
        publishConversationData(payload, requestUrl);
      })
      .catch(() => {
        // A changed or streaming response format is handled by the DOM
        // fallback in navigation.js.
      });
  }

  window.fetch = function gptTweaksFetch(...args) {
    const request = args[0];
    const requestUrl =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request instanceof Request
            ? request.url
            : "";
    const responsePromise = originalFetch.apply(this, args);

    responsePromise.then(
      response => {
        inspectResponse(response, requestUrl);
      },
      () => {
        // Preserve ChatGPT's original rejected promise without creating an
        // additional unhandled rejection from the inspection branch.
      }
    );

    return responsePromise;
  };
})();
