(() => {
  "use strict";

  const DATA_EVENT = "gpt-tweaks:conversation-data";
  const CONVERSATION_URL_PATTERN =
    /\/backend-api\/conversation\/([^/?#]+)/;
  const originalFetch = window.fetch;
  const REFERENCE_COLLECTION_KEYS = [
    "items",
    "fallback_items",
    "sources"
  ];
  const CONTENT_METADATA_KEYS = new Set([
    "asset_pointer",
    "content_type",
    "fovea",
    "format",
    "height",
    "language",
    "mime_type",
    "size_bytes",
    "status",
    "width"
  ]);

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
   * Add human-readable strings from a structured content value without
   * leaking transport identifiers and asset pointers into the export.
   *
   * @param {unknown} value
   * @param {Array<string>} output
   * @param {number} depth
   * @param {Set<object>} visited
   */
  function collectContentText(
    value,
    output,
    depth = 0,
    visited = new Set()
  ) {
    if (depth > 6 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      const text = value.trim();

      if (text && output.at(-1) !== text) {
        output.push(text);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(item => {
        collectContentText(item, output, depth + 1, visited);
      });
      return;
    }

    if (typeof value !== "object" || visited.has(value)) {
      return;
    }

    visited.add(value);

    for (const [key, nestedValue] of Object.entries(value)) {
      if (
        CONTENT_METADATA_KEYS.has(key) ||
        key === "metadata" ||
        key === "safe_urls" ||
        key.endsWith("_id")
      ) {
        continue;
      }

      collectContentText(
        nestedValue,
        output,
        depth + 1,
        visited
      );
    }
  }

  /**
   * Read Markdown or other visible text from all known ChatGPT content
   * variants, including optional internal message types.
   *
   * @param {unknown} content
   * @returns {string}
   */
  function readMessageText(content) {
    if (!content || typeof content !== "object") {
      return "";
    }

    const output = [];
    collectContentText(content, output);

    return output.join("\n\n").trim();
  }

  /**
   * Keep only attachment descriptors that remain meaningful in a Markdown
   * file. Binary data and private asset pointers are intentionally omitted.
   *
   * @param {unknown} message
   * @returns {Array<object>}
   */
  function readAttachments(message) {
    if (!message || typeof message !== "object") {
      return [];
    }

    const candidates = [];
    const metadataAttachments =
      Array.isArray(message.metadata?.attachments)
        ? message.metadata.attachments
        : [];

    metadataAttachments.forEach(attachment => {
      if (!attachment || typeof attachment !== "object") {
        return;
      }

      candidates.push({
        name:
          typeof attachment.name === "string"
            ? attachment.name
            : "",
        mimeType:
          typeof attachment.mime_type === "string"
            ? attachment.mime_type
            : "",
        size:
          Number.isFinite(attachment.size)
            ? attachment.size
            : null
      });
    });

    const parts = Array.isArray(message.content?.parts)
      ? message.content.parts
      : [];

    parts.forEach(part => {
      if (
        !part ||
        typeof part !== "object" ||
        typeof part.asset_pointer !== "string"
      ) {
        return;
      }

      const partMetadata =
        part.metadata && typeof part.metadata === "object"
          ? part.metadata
          : {};

      candidates.push({
        name:
          typeof partMetadata.name === "string"
            ? partMetadata.name
            : typeof partMetadata.filename === "string"
              ? partMetadata.filename
              : "",
        mimeType:
          typeof part.mime_type === "string"
            ? part.mime_type
            : "",
        size:
          Number.isFinite(part.size_bytes)
            ? part.size_bytes
            : null
      });
    });

    const seen = new Set();
    return candidates.filter(attachment => {
      const signature =
        `${attachment.name}:${attachment.mimeType}:` +
        `${attachment.size ?? ""}`;

      if (seen.has(signature)) {
        return false;
      }

      seen.add(signature);
      return true;
    });
  }

  /**
   * Extract public-facing source links from a content reference.
   *
   * @param {unknown} reference
   * @returns {Array<object>}
   */
  function readReferenceLinks(reference) {
    if (!reference || typeof reference !== "object") {
      return [];
    }

    const links = [];
    const addLink = candidate => {
      if (!candidate || typeof candidate !== "object") {
        return;
      }

      const url =
        typeof candidate.url === "string"
          ? candidate.url
          : typeof candidate.link === "string"
            ? candidate.link
            : "";

      if (!url || !/^https?:\/\//i.test(url)) {
        return;
      }

      links.push({
        title:
          typeof candidate.title === "string"
            ? candidate.title
            : typeof candidate.name === "string"
              ? candidate.name
              : "",
        url
      });
    };

    addLink(reference);
    REFERENCE_COLLECTION_KEYS.forEach(key => {
      const collection = reference[key];

      if (Array.isArray(collection)) {
        collection.forEach(addLink);
      }
    });

    if (Array.isArray(reference.safe_urls)) {
      reference.safe_urls.forEach(url => {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          links.push({title: "", url});
        }
      });
    }

    const seen = new Set();
    return links.filter(link => {
      if (seen.has(link.url)) {
        return false;
      }

      seen.add(link.url);
      return true;
    });
  }

  /**
   * Reduce ChatGPT content references to the text marker and public links
   * required by the Markdown formatter.
   *
   * @param {unknown} metadata
   * @returns {Array<object>}
   */
  function readReferences(metadata) {
    const references =
      metadata &&
      typeof metadata === "object" &&
      Array.isArray(metadata.content_references)
        ? metadata.content_references
        : [];

    return references
      .filter(
        reference =>
          reference && typeof reference === "object"
      )
      .map(reference => ({
        type:
          typeof reference.type === "string"
            ? reference.type
            : "",
        matchedText:
          typeof reference.matched_text === "string"
            ? reference.matched_text
            : "",
        alt:
          typeof reference.alt === "string"
            ? reference.alt
            : "",
        links: readReferenceLinks(reference)
      }))
      .filter(
        reference =>
          reference.matchedText ||
          reference.alt ||
          reference.links.length > 0
      );
  }

  /**
   * Return only the active branch, from root to current_node.
   *
   * @param {object} mapping
   * @param {unknown} currentNode
   * @returns {Array<object>}
   */
  function buildActivePath(mapping, currentNode) {
    if (typeof currentNode !== "string") {
      return [];
    }

    const path = [];
    const visited = new Set();
    let node = mapping[currentNode];

    while (
      node &&
      typeof node === "object" &&
      typeof node.id === "string" &&
      !visited.has(node.id)
    ) {
      visited.add(node.id);
      path.push(node);
      node =
        typeof node.parent === "string"
          ? mapping[node.parent]
          : null;
    }

    return path.reverse();
  }

  /**
   * Publish a sanitized active conversation branch. The isolated content
   * scripts receive enough text for opt-in exports, while authentication
   * headers, binary assets and unrelated branches remain in the page world.
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
    const activePath = buildActivePath(
      conversation.mapping,
      conversation.current_node
    );
    const nodes = activePath
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
        const authorName =
          typeof message?.author?.name === "string"
            ? message.author.name
            : "";
        const contentType =
          typeof message?.content?.content_type === "string"
            ? message.content.content_type
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
              : "",
          authorName,
          contentType,
          text: readMessageText(message?.content),
          hidden:
            message?.metadata
              ?.is_visually_hidden_from_conversation === true,
          status:
            typeof message?.status === "string"
              ? message.status
              : "",
          recipient:
            typeof message?.recipient === "string"
              ? message.recipient
              : "",
          createTime:
            typeof message?.create_time === "number"
              ? message.create_time
              : null,
          turnExchangeId:
            typeof message?.metadata?.turn_exchange_id === "string"
              ? message.metadata.turn_exchange_id
              : "",
          attachments: readAttachments(message),
          references: readReferences(message?.metadata)
        };
      })
      .filter(node => node.id);

    const detail = JSON.stringify({
      version: 2,
      conversationId:
        typeof conversation.conversation_id === "string"
          ? conversation.conversation_id
          : requestConversationId,
      title:
        typeof conversation.title === "string"
          ? conversation.title
          : "",
      currentNode:
        typeof conversation.current_node === "string"
          ? conversation.current_node
          : null,
      nodes,
      complete: activePath.length > 0
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
