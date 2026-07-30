(() => {
  "use strict";

  const DATA_EVENT = "gpt-tweaks:conversation-data";
  const COPY_BUTTON_SELECTOR =
    'button[data-testid="copy-turn-action-button"], ' +
    'button[aria-label="复制回复"]';
  const MENU_ID = "gpt-tweaks-reply-download-menu";
  const TOAST_ID = "gpt-tweaks-download-toast";
  const GET_EXPORT_STATE = "gpt-tweaks:get-export-state";
  const EXPORT_CONVERSATION =
    "gpt-tweaks:export-conversation";
  const SAVE_MARKDOWN = "gpt-tweaks:save-markdown";
  const CLOSE_DELAY = 220;

  let closeTimer = 0;
  let menu = null;
  let menuButton = null;
  let menuTarget = null;
  let scanFrame = 0;
  let toastTimer = 0;
  let snapshot = createEmptySnapshot();

  /**
   * @returns {object}
   */
  function createEmptySnapshot() {
    return {
      complete: false,
      conversationId: "",
      currentNode: "",
      title: "",
      nodes: [],
      preamble: [],
      rounds: []
    };
  }

  /**
   * @returns {string}
   */
  function getRouteConversationId() {
    return location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? "";
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function readString(value) {
    return typeof value === "string" ? value : "";
  }

  /**
   * @param {unknown} value
   * @returns {Array<object>}
   */
  function readObjectArray(value) {
    return Array.isArray(value)
      ? value.filter(item => item && typeof item === "object")
      : [];
  }

  /**
   * Revalidate bridge data before retaining it in the isolated world.
   *
   * @param {unknown} rawNode
   * @returns {object | null}
   */
  function normalizeNode(rawNode) {
    if (
      !rawNode ||
      typeof rawNode !== "object" ||
      typeof rawNode.id !== "string"
    ) {
      return null;
    }

    return {
      id: rawNode.id,
      parent: readString(rawNode.parent),
      role: readString(rawNode.role),
      authorName: readString(rawNode.authorName),
      messageId: readString(rawNode.messageId),
      label: readString(rawNode.label),
      contentType: readString(rawNode.contentType),
      text: readString(rawNode.text),
      hidden: rawNode.hidden === true,
      status: readString(rawNode.status),
      recipient: readString(rawNode.recipient),
      createTime:
        typeof rawNode.createTime === "number"
          ? rawNode.createTime
          : null,
      turnExchangeId: readString(rawNode.turnExchangeId),
      attachments: readObjectArray(rawNode.attachments).map(
        attachment => ({
          name: readString(attachment.name),
          mimeType: readString(attachment.mimeType),
          size:
            typeof attachment.size === "number"
              ? attachment.size
              : null
        })
      ),
      references: readObjectArray(rawNode.references).map(
        reference => ({
          type: readString(reference.type),
          matchedText: readString(reference.matchedText),
          alt: readString(reference.alt),
          links: readObjectArray(reference.links)
            .map(link => ({
              title: readString(link.title),
              url: readString(link.url)
            }))
            .filter(link => /^https?:\/\//i.test(link.url))
        })
      ),
      source: "model"
    };
  }

  /**
   * Use the same compact prompt style as the conversation navigator.
   *
   * @param {string} text
   * @param {number} index
   * @returns {string}
   */
  function createLabel(text, index) {
    const compact = text.replace(/\s+/g, " ").trim();

    if (!compact) {
      return `提问 ${index}`;
    }

    const characters = [...compact];
    return characters.length > 200
      ? `${characters.slice(0, 197).join("")}...`
      : compact;
  }

  /**
   * Group active-path nodes into user-led conversation rounds.
   *
   * @param {Array<object>} nodes
   * @returns {{preamble: Array<object>, rounds: Array<object>}}
   */
  function groupNodesIntoRounds(nodes) {
    const preamble = [];
    const rounds = [];
    let currentRound = null;

    nodes.forEach(node => {
      if (node.role === "user") {
        currentRound = {
          id: node.id,
          index: rounds.length + 1,
          label:
            node.label ||
            createLabel(node.text, rounds.length + 1),
          userTurnId: node.id,
          userMessageId: node.messageId,
          messages: [node]
        };
        rounds.push(currentRound);
        return;
      }

      if (currentRound) {
        currentRound.messages.push(node);
      } else {
        preamble.push(node);
      }
    });

    return {preamble, rounds};
  }

  /**
   * Replace the in-memory snapshot with the latest complete active branch.
   *
   * @param {CustomEvent} event
   */
  function handleConversationData(event) {
    if (typeof event.detail !== "string") {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch {
      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(payload.nodes)
    ) {
      return;
    }

    const routeConversationId = getRouteConversationId();
    const conversationId =
      readString(payload.conversationId) || routeConversationId;

    if (
      routeConversationId &&
      conversationId &&
      routeConversationId !== conversationId
    ) {
      return;
    }

    const nodes = payload.nodes
      .map(normalizeNode)
      .filter(Boolean);
    const grouped = groupNodesIntoRounds(nodes);

    snapshot = {
      complete: payload.complete === true && nodes.length > 0,
      conversationId,
      currentNode: readString(payload.currentNode),
      title:
        readString(payload.title) ||
        document.title.replace(/\s*[-–—]\s*ChatGPT\s*$/i, ""),
      nodes,
      preamble: grouped.preamble,
      rounds: grouped.rounds
    };

    scheduleRenderedScan();
  }

  /**
   * @param {Element} section
   * @returns {number | null}
   */
  function readRenderedRoundIndex(section) {
    const testId = section.getAttribute("data-testid") ?? "";
    const turnNumber = Number.parseInt(
      testId.match(/^conversation-turn-(\d+)$/)?.[1] ?? "",
      10
    );

    return Number.isFinite(turnNumber)
      ? Math.ceil(turnNumber / 2)
      : null;
  }

  /**
   * @param {Element} section
   * @returns {string}
   */
  function readTurnId(section) {
    return (
      section.getAttribute("data-turn-id") ??
      section.getAttribute("data-turn-id-container") ??
      ""
    );
  }

  /**
   * @param {Element} section
   * @param {string} role
   * @returns {Element | null}
   */
  function findMessageElement(section, role) {
    const messages = [
      ...section.querySelectorAll(
        `[data-message-author-role="${CSS.escape(role)}"]`
      )
    ];

    if (role === "assistant") {
      return (
        messages.find(message =>
          message.querySelector(".markdown")
        ) ??
        messages.at(-1) ??
        null
      );
    }

    return messages[0] ?? null;
  }

  /**
   * Escape text used as a Markdown link label.
   *
   * @param {string} text
   * @returns {string}
   */
  function escapeLinkLabel(text) {
    return text.replace(/([\\[\]])/g, "\\$1");
  }

  /**
   * @param {Element} table
   * @returns {string}
   */
  function serializeTable(table) {
    const rows = [...table.querySelectorAll("tr")].map(row =>
      [...row.querySelectorAll(":scope > th, :scope > td")].map(
        cell =>
          normalizeInlineMarkdown(
            serializeChildren(cell)
          ).replace(/\|/g, "\\|")
      )
    );

    if (rows.length === 0) {
      return "";
    }

    const width = Math.max(...rows.map(row => row.length));
    const normalizedRows = rows.map(row => [
      ...row,
      ...Array(Math.max(0, width - row.length)).fill("")
    ]);
    const header = normalizedRows[0];
    const divider = Array(width).fill("---");
    const body = normalizedRows.slice(1);

    return [
      `| ${header.join(" | ")} |`,
      `| ${divider.join(" | ")} |`,
      ...body.map(row => `| ${row.join(" | ")} |`)
    ].join("\n");
  }

  /**
   * @param {Element} list
   * @param {number} depth
   * @returns {string}
   */
  function serializeList(list, depth = 0) {
    const ordered = list.tagName === "OL";
    const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
    const items = [...list.children].filter(
      child => child.tagName === "LI"
    );

    return items
      .map((item, index) => {
        const nestedLists = [...item.children].filter(
          child => child.matches("ul, ol")
        );
        const clone = item.cloneNode(true);
        clone.querySelectorAll("ul, ol").forEach(child => {
          child.remove();
        });

        const prefix = ordered
          ? `${Number.isFinite(start) ? start + index : index + 1}. `
          : "- ";
        const indentation = "  ".repeat(depth);
        const body = normalizeInlineMarkdown(
          serializeChildren(clone)
        );
        const continuation = body
          .split("\n")
          .map((line, lineIndex) =>
            lineIndex === 0
              ? line
              : `${indentation}  ${line}`
          )
          .join("\n");
        const nested = nestedLists
          .map(nestedList =>
            serializeList(nestedList, depth + 1)
          )
          .filter(Boolean)
          .join("\n");

        return (
          `${indentation}${prefix}${continuation}` +
          (nested ? `\n${nested}` : "")
        );
      })
      .join("\n");
  }

  /**
   * @param {Node} node
   * @returns {string}
   */
  function serializeMarkdownNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue ?? "";
    }

    if (!(node instanceof Element)) {
      return "";
    }

    const tag = node.tagName;
    const inner = () => serializeChildren(node);

    if (/^H[1-6]$/.test(tag)) {
      return (
        `${"#".repeat(Number.parseInt(tag.slice(1), 10))} ` +
        `${normalizeInlineMarkdown(inner())}\n\n`
      );
    }

    switch (tag) {
      case "P":
        return `${inner().trim()}\n\n`;
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return `**${inner()}**`;
      case "EM":
      case "I":
        return `*${inner()}*`;
      case "S":
      case "DEL":
        return `~~${inner()}~~`;
      case "A": {
        const href = node.getAttribute("href") ?? "";
        const label =
          normalizeInlineMarkdown(inner()) || href;
        return href
          ? `[${escapeLinkLabel(label)}](${href.replace(/\)/g, "%29")})`
          : label;
      }
      case "CODE": {
        if (node.parentElement?.tagName === "PRE") {
          return node.textContent ?? "";
        }

        const code = node.textContent ?? "";
        const fence = code.includes("`") ? "``" : "`";
        return `${fence}${code}${fence}`;
      }
      case "PRE": {
        const code = node.querySelector("code") ?? node;
        const language =
          [...code.classList]
            .find(className =>
              className.startsWith("language-")
            )
            ?.slice("language-".length) ?? "";
        const text = code.textContent ?? "";
        const fence = text.includes("```") ? "````" : "```";
        return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
      }
      case "UL":
      case "OL":
        return `${serializeList(node)}\n\n`;
      case "BLOCKQUOTE": {
        const quote = normalizeMarkdown(inner())
          .split("\n")
          .map(line => `> ${line}`)
          .join("\n");
        return `${quote}\n\n`;
      }
      case "TABLE":
        return `${serializeTable(node)}\n\n`;
      case "HR":
        return "---\n\n";
      case "IMG": {
        const alt = node.getAttribute("alt")?.trim() || "图片";
        return `[图片：${alt}]`;
      }
      default:
        return inner();
    }
  }

  /**
   * @param {Node} node
   * @returns {string}
   */
  function serializeChildren(node) {
    return [...node.childNodes]
      .map(serializeMarkdownNode)
      .join("");
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function normalizeInlineMarkdown(text) {
    return text
      .replace(/[ \t]*\n[ \t]*/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function normalizeMarkdown(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * @param {Element} section
   * @param {"user" | "assistant"} role
   * @returns {object | null}
   */
  function createDomMessage(section, role) {
    const message = findMessageElement(section, role);
    if (!(message instanceof Element)) {
      return null;
    }

    const markdown =
      role === "assistant"
        ? message.querySelector(".markdown")
        : null;
    const text =
      markdown instanceof Element
        ? normalizeMarkdown(serializeChildren(markdown))
        : (message.textContent ?? "").trim();

    return {
      id: readTurnId(section),
      parent: "",
      role,
      authorName: "",
      messageId:
        message.getAttribute("data-message-id") ?? "",
      label: role === "user" ? createLabel(text, 1) : "",
      contentType: "text",
      text,
      hidden: false,
      status: "",
      recipient: "",
      createTime: null,
      turnExchangeId: "",
      attachments: [],
      references: [],
      source: "dom"
    };
  }

  /**
   * @param {object} node
   * @param {object} candidate
   * @returns {boolean}
   */
  function sameMessage(node, candidate) {
    return Boolean(
      (node.id && node.id === candidate.id) ||
      (
        node.messageId &&
        node.messageId === candidate.messageId
      )
    );
  }

  /**
   * Merge rendered newest turns into the model snapshot without replacing
   * higher-fidelity raw Markdown already captured from the response.
   */
  function scanRenderedTurns() {
    scanFrame = 0;

    const routeConversationId = getRouteConversationId();
    if (
      snapshot.conversationId &&
      routeConversationId &&
      snapshot.conversationId !== routeConversationId
    ) {
      snapshot = createEmptySnapshot();
      closeMenu();
    }

    if (!routeConversationId) {
      closeMenu();
      return;
    }

    if (menuTarget && !document.contains(menuTarget)) {
      closeMenu();
    }

    const sections = [
      ...document.querySelectorAll("section[data-turn]")
    ];
    let currentRound = null;

    sections.forEach(section => {
      const role = section.getAttribute("data-turn");
      if (role !== "user" && role !== "assistant") {
        return;
      }

      const domMessage = createDomMessage(section, role);
      if (!domMessage) {
        return;
      }

      if (role === "user") {
        currentRound =
          snapshot.rounds.find(
            round =>
              round.userTurnId === domMessage.id ||
              (
                round.userMessageId &&
                round.userMessageId === domMessage.messageId
              )
          ) ?? null;

        if (!currentRound && snapshot.complete) {
          const renderedIndex =
            readRenderedRoundIndex(section) ??
            snapshot.rounds.length + 1;
          currentRound = {
            id: domMessage.id || domMessage.messageId,
            index: renderedIndex,
            label: createLabel(
              domMessage.text,
              renderedIndex
            ),
            userTurnId: domMessage.id,
            userMessageId: domMessage.messageId,
            messages: [domMessage]
          };
          snapshot.rounds.push(currentRound);
        }
        return;
      }

      const knownRound =
        snapshot.rounds.find(round =>
          round.messages.some(message =>
            sameMessage(message, domMessage)
          )
        ) ?? currentRound;

      if (!knownRound) {
        return;
      }

      const existingMessage = knownRound.messages.find(message =>
        sameMessage(message, domMessage)
      );

      if (!existingMessage) {
        knownRound.messages.push(domMessage);
      } else if (existingMessage.source === "dom") {
        existingMessage.text = domMessage.text;
      }
    });

    snapshot.rounds.sort(
      (left, right) => left.index - right.index
    );
  }

  /**
   * Coalesce the page's frequent streaming and virtual-scroll mutations.
   */
  function scheduleRenderedScan() {
    if (!scanFrame) {
      scanFrame = requestAnimationFrame(scanRenderedTurns);
    }
  }

  /**
   * @param {object} message
   * @returns {"user" | "assistant" | "system" | "tool" | "thoughts" | "reasoning" | "other"}
   */
  function classifyMessage(message) {
    const role = message.role.toLowerCase();
    const contentType = message.contentType.toLowerCase();

    if (contentType.includes("thought")) {
      return "thoughts";
    }

    if (contentType.includes("reasoning")) {
      return "reasoning";
    }

    if (role === "system") {
      return "system";
    }

    if (
      role === "tool" ||
      contentType === "code" ||
      contentType === "execution_output"
    ) {
      return "tool";
    }

    if (role === "user") {
      return "user";
    }

    if (
      role === "assistant" &&
      (contentType === "text" || !contentType) &&
      (message.text || message.attachments.length > 0)
    ) {
      return "assistant";
    }

    return "other";
  }

  /**
   * @param {object} round
   * @returns {object | null}
   */
  function findFinalAssistant(round) {
    return (
      round.messages
        .filter(
          message =>
            classifyMessage(message) === "assistant" &&
            !message.hidden
        )
        .at(-1) ?? null
    );
  }

  /**
   * @param {number | null} bytes
   * @returns {string}
   */
  function formatByteSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "";
    }

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Replace ChatGPT reference markers and append a deduplicated source list.
   *
   * @param {string} text
   * @param {Array<object>} references
   * @returns {string}
   */
  function renderReferences(text, references) {
    let rendered = text;
    const links = [];

    references.forEach(reference => {
      const replacement = reference.links
        .map(link => {
          const title =
            link.title || reference.alt || link.url;
          return (
            `[${escapeLinkLabel(title)}](` +
            `${link.url.replace(/\)/g, "%29")})`
          );
        })
        .join("、");

      if (reference.matchedText) {
        rendered = rendered.split(reference.matchedText).join(
          replacement ? `（${replacement}）` : ""
        );
      }

      reference.links.forEach(link => {
        links.push({
          title:
            link.title || reference.alt || link.url,
          url: link.url
        });
      });
    });

    rendered = rendered.replace(/[^]*/g, "");

    const seen = new Set();
    const uniqueLinks = links.filter(link => {
      if (seen.has(link.url)) {
        return false;
      }

      seen.add(link.url);
      return true;
    });

    if (uniqueLinks.length === 0) {
      return normalizeMarkdown(rendered);
    }

    const sourceList = uniqueLinks
      .map(
        link =>
          `- [${escapeLinkLabel(link.title)}](` +
          `${link.url.replace(/\)/g, "%29")})`
      )
      .join("\n");

    return normalizeMarkdown(
      `${rendered}\n\n**来源**\n\n${sourceList}`
    );
  }

  /**
   * @param {object} message
   * @returns {string}
   */
  function formatMessageBody(message) {
    const sections = [];
    const text = renderReferences(
      message.text,
      message.references
    );

    if (text) {
      sections.push(text);
    }

    if (message.attachments.length > 0) {
      const attachmentLines = message.attachments.map(
        (attachment, index) => {
          const name =
            attachment.name ||
            (
              attachment.mimeType.startsWith("image/")
                ? `图片 ${index + 1}`
                : `附件 ${index + 1}`
            );
          const details = [
            attachment.mimeType,
            formatByteSize(attachment.size)
          ].filter(Boolean);

          return (
            `- ${name}` +
            (details.length > 0
              ? `（${details.join("，")}）`
              : "")
          );
        }
      );

      sections.push(
        `**附件**\n\n${attachmentLines.join("\n")}`
      );
    }

    return normalizeMarkdown(sections.join("\n\n"));
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function escapeHeading(text) {
    return text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * @param {object} message
   * @param {string} category
   * @returns {string}
   */
  function createMessageHeading(message, category) {
    const labels = {
      user: "用户",
      assistant: "ChatGPT",
      system: "System",
      tool: "Tool",
      thoughts: "Thoughts",
      reasoning: "Reasoning",
      other: "其他内部消息"
    };
    const toolName =
      category === "tool"
        ? message.recipient || message.authorName
        : "";
    const hiddenPrefix = message.hidden ? "隐藏 · " : "";

    return (
      `${hiddenPrefix}${labels[category]}` +
      (toolName ? ` · ${escapeHeading(toolName)}` : "")
    );
  }

  /**
   * @param {object} options
   * @returns {object}
   */
  function normalizeExportOptions(options) {
    const source =
      options && typeof options === "object"
        ? options
        : {};

    return {
      includeSystem: source.includeSystem === true,
      includeTool: source.includeTool === true,
      includeThoughts: source.includeThoughts === true,
      includeReasoning: source.includeReasoning === true,
      includeHidden: source.includeHidden === true,
      includeOther: source.includeOther === true
    };
  }

  /**
   * @param {object} message
   * @param {string} category
   * @param {object} options
   * @param {boolean} isFinalAssistant
   * @returns {boolean}
   */
  function shouldIncludeMessage(
    message,
    category,
    options,
    isFinalAssistant
  ) {
    if (message.hidden && !options.includeHidden) {
      return false;
    }

    if (category === "user") {
      return true;
    }

    if (category === "assistant") {
      return isFinalAssistant || options.includeOther;
    }

    const optionByCategory = {
      system: options.includeSystem,
      tool: options.includeTool,
      thoughts: options.includeThoughts,
      reasoning: options.includeReasoning,
      other: options.includeOther
    };

    return optionByCategory[category] === true;
  }

  /**
   * @param {object} round
   * @param {object} options
   * @returns {string}
   */
  function formatRound(round, options) {
    const sections = [
      `## 第 ${round.index} 轮：${escapeHeading(round.label)}`
    ];
    const finalAssistant = findFinalAssistant(round);

    round.messages.forEach(message => {
      let category = classifyMessage(message);
      const isFinalAssistant =
        category === "assistant" &&
        message === finalAssistant;

      if (category === "assistant" && !isFinalAssistant) {
        category = "other";
      }

      if (
        !shouldIncludeMessage(
          message,
          category,
          options,
          isFinalAssistant
        )
      ) {
        return;
      }

      const body = formatMessageBody(message);
      if (!body) {
        return;
      }

      sections.push(
        `### ${createMessageHeading(message, category)}\n\n${body}`
      );
    });

    if (!finalAssistant) {
      sections.push(
        "*本轮没有可导出的 ChatGPT 最终回复。*"
      );
    }

    return sections.join("\n\n");
  }

  /**
   * @param {Array<object>} messages
   * @param {object} options
   * @returns {string}
   */
  function formatPreamble(messages, options) {
    const sections = [];

    messages.forEach(message => {
      const category = classifyMessage(message);

      if (
        !shouldIncludeMessage(
          message,
          category,
          options,
          false
        )
      ) {
        return;
      }

      const body = formatMessageBody(message);
      if (!body) {
        return;
      }

      sections.push(
        `### ${createMessageHeading(message, category)}\n\n${body}`
      );
    });

    return sections.length > 0
      ? `## Session 级消息\n\n${sections.join("\n\n")}`
      : "";
  }

  /**
   * @param {object} request
   * @returns {{markdown: string, filename: string, count: number}}
   */
  function buildConversationExport(request) {
    if (!snapshot.complete || snapshot.rounds.length === 0) {
      throw new Error(
        "完整会话数据尚未就绪，请刷新当前 ChatGPT 对话后重试。"
      );
    }

    const mode =
      request.mode === "selected" ? "selected" : "all";
    const selectedIds = new Set(
      Array.isArray(request.roundIds)
        ? request.roundIds.filter(id => typeof id === "string")
        : []
    );
    const rounds =
      mode === "all"
        ? snapshot.rounds
        : snapshot.rounds.filter(round =>
            selectedIds.has(round.id)
          );

    if (rounds.length === 0) {
      throw new Error("请至少选择一个对话轮次。");
    }

    const options = normalizeExportOptions(request.options);
    const title =
      snapshot.title || document.title || "ChatGPT 对话";
    const sections = [
      `# ${escapeHeading(title)}`,
      [
        "> 导出自 ChatGPT",
        `> 原始会话：${location.href}`,
        `> 导出时间：${new Date().toLocaleString()}`
      ].join("\n")
    ];
    const preamble = formatPreamble(
      snapshot.preamble,
      options
    );

    if (preamble) {
      sections.push(preamble);
    }

    rounds.forEach(round => {
      sections.push(formatRound(round, options));
    });

    const suffix =
      mode === "all"
        ? ""
        : `-选中${rounds.length}轮`;

    return {
      markdown: `${normalizeMarkdown(sections.join("\n\n"))}\n`,
      filename: `${sanitizeFilename(title)}${suffix}.md`,
      count: rounds.length
    };
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function sanitizeFilename(value) {
    const filename = value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[.\s]+$/g, "")
      .trim();
    const characters = [...filename];
    const shortened =
      characters.length > 100
        ? characters.slice(0, 100).join("").trim()
        : filename;

    return shortened || "ChatGPT 对话";
  }

  /**
   * @param {string} markdown
   * @returns {Promise<void>}
   */
  async function copyMarkdown(markdown) {
    try {
      await navigator.clipboard.writeText(markdown);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = markdown;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();

      if (!copied) {
        throw new Error("浏览器拒绝了剪贴板写入。");
      }
    }
  }

  /**
   * @param {string} filename
   * @param {string} markdown
   * @returns {Promise<object>}
   */
  function requestDownload(filename, markdown) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: SAVE_MARKDOWN,
          filename,
          markdown
        },
        response => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          if (!response?.ok) {
            reject(
              new Error(
                response?.error || "无法启动 Markdown 下载。"
              )
            );
            return;
          }

          resolve(response);
        }
      );
    });
  }

  /**
   * @param {object} request
   * @returns {Promise<object>}
   */
  async function handleExportRequest(request) {
    scanRenderedTurns();
    const exported = buildConversationExport(request);

    if (request.action === "copy") {
      await copyMarkdown(exported.markdown);
    } else {
      await requestDownload(
        exported.filename,
        exported.markdown
      );
    }

    return {
      ok: true,
      count: exported.count,
      action:
        request.action === "copy" ? "copy" : "download"
    };
  }

  /**
   * @returns {object}
   */
  function getExportState() {
    scanRenderedTurns();

    const routeConversationId = getRouteConversationId();
    if (!routeConversationId) {
      return {
        ok: false,
        error: "请在 ChatGPT 的具体对话页面中使用此功能。"
      };
    }

    if (
      !snapshot.complete ||
      snapshot.conversationId !== routeConversationId
    ) {
      return {
        ok: false,
        error:
          "完整会话数据尚未就绪，请刷新当前 ChatGPT 对话后重新打开扩展菜单。"
      };
    }

    return {
      ok: true,
      title: snapshot.title || document.title,
      conversationId: snapshot.conversationId,
      rounds: snapshot.rounds.map(round => ({
        id: round.id,
        index: round.index,
        label: round.label,
        hasAssistant: Boolean(findFinalAssistant(round))
      }))
    };
  }

  /**
   * @param {HTMLButtonElement} target
   * @returns {{message: object, round: object | null}}
   */
  function findReplyForButton(target) {
    const section = target.closest(
      'section[data-turn="assistant"]'
    );

    if (!(section instanceof Element)) {
      throw new Error("无法识别这条 AI 回复。");
    }

    const domMessage = createDomMessage(section, "assistant");
    if (!domMessage) {
      throw new Error("无法读取这条 AI 回复。");
    }

    if (domMessage.messageId) {
      for (const round of snapshot.rounds) {
        const message = round.messages.find(
          candidate =>
            candidate.messageId === domMessage.messageId
        );

        if (message) {
          return {
            message:
              formatMessageBody(message)
                ? message
                : domMessage,
            round
          };
        }
      }
    }

    if (domMessage.id) {
      const round =
        snapshot.rounds.find(candidateRound =>
          candidateRound.messages.some(
            message => message.id === domMessage.id
          )
        ) ?? null;

      if (round) {
        const finalAssistant = findFinalAssistant(round);

        if (
          finalAssistant &&
          formatMessageBody(finalAssistant)
        ) {
          return {message: finalAssistant, round};
        }

        return {message: domMessage, round};
      }
    }

    return {message: domMessage, round: null};
  }

  /**
   * @param {string} message
   * @param {"success" | "error"} type
   */
  function showToast(message, type = "success") {
    let toast = document.querySelector(`#${TOAST_ID}`);

    if (!(toast instanceof HTMLElement)) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }

    window.clearTimeout(toastTimer);
    toast.dataset.type = type;
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  /**
   * Create the shared one-option menu once.
   */
  function ensureMenu() {
    if (menu) {
      return;
    }

    menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "回复下载");
    menu.hidden = true;

    menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.setAttribute("role", "menuitem");
    menuButton.textContent = "下载此对话";
    menuButton.addEventListener("click", async () => {
      const target = menuTarget;

      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      menuButton.disabled = true;
      try {
        const {message, round} = findReplyForButton(target);
        const markdown = formatMessageBody(message);

        if (!markdown) {
          throw new Error("这条 AI 回复没有可下载的正文。");
        }

        const title =
          snapshot.title || document.title || "ChatGPT 对话";
        const roundPart = round
          ? `-第${round.index}轮-${round.label}`
          : "-AI回复";
        await requestDownload(
          `${sanitizeFilename(title + roundPart)}.md`,
          `${markdown}\n`
        );
        closeMenu();
        showToast("已打开另存为窗口");
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : "无法下载这条 AI 回复。",
          "error"
        );
      } finally {
        menuButton.disabled = false;
      }
    });

    menu.addEventListener("pointerenter", cancelMenuClose);
    menu.addEventListener("pointerleave", scheduleMenuClose);
    menu.addEventListener("focusin", cancelMenuClose);
    menu.addEventListener("focusout", event => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !menu?.contains(event.relatedTarget)
      ) {
        scheduleMenuClose();
      }
    });

    menu.append(menuButton);
    document.body.append(menu);
  }

  /**
   * @param {HTMLButtonElement} target
   */
  function positionMenu(target) {
    if (!menu || menu.hidden) {
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    let top = targetRect.bottom + 6;

    if (top + menuRect.height > innerHeight - viewportPadding) {
      top = targetRect.top - menuRect.height - 6;
    }

    const left = Math.min(
      innerWidth - menuRect.width - viewportPadding,
      Math.max(
        viewportPadding,
        targetRect.left +
          targetRect.width / 2 -
          menuRect.width / 2
      )
    );

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
  }

  /**
   * @param {HTMLButtonElement} target
   */
  function openMenu(target) {
    ensureMenu();
    cancelMenuClose();

    if (menuTarget && menuTarget !== target) {
      menuTarget.removeAttribute("aria-expanded");
    }

    menuTarget = target;
    menu.hidden = false;
    target.setAttribute("aria-haspopup", "menu");
    target.setAttribute("aria-controls", MENU_ID);
    target.setAttribute("aria-expanded", "true");
    positionMenu(target);
  }

  /**
   * Cancel a pending hover close.
   */
  function cancelMenuClose() {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
  }

  /**
   * Close after a short gap so the pointer can cross into the menu.
   */
  function scheduleMenuClose() {
    cancelMenuClose();
    closeTimer = window.setTimeout(closeMenu, CLOSE_DELAY);
  }

  /**
   * Close the shared reply menu.
   */
  function closeMenu() {
    cancelMenuClose();
    if (menuTarget) {
      menuTarget.removeAttribute("aria-expanded");
    }
    if (menu) {
      menu.hidden = true;
    }
    menuTarget = null;
  }

  document.addEventListener("pointerover", event => {
    const target =
      event.target instanceof Element
        ? event.target.closest(COPY_BUTTON_SELECTOR)
        : null;

    if (target instanceof HTMLButtonElement) {
      openMenu(target);
    }
  });

  document.addEventListener("pointerout", event => {
    const target =
      event.target instanceof Element
        ? event.target.closest(COPY_BUTTON_SELECTOR)
        : null;

    if (
      target instanceof HTMLButtonElement &&
      (
        !(event.relatedTarget instanceof Node) ||
        !target.contains(event.relatedTarget)
      )
    ) {
      scheduleMenuClose();
    }
  });

  document.addEventListener("focusin", event => {
    const target =
      event.target instanceof Element
        ? event.target.closest(COPY_BUTTON_SELECTOR)
        : null;

    if (target instanceof HTMLButtonElement) {
      openMenu(target);
    }
  });

  document.addEventListener("focusout", event => {
    const target =
      event.target instanceof Element
        ? event.target.closest(COPY_BUTTON_SELECTOR)
        : null;

    if (
      target instanceof HTMLButtonElement &&
      (
        !(event.relatedTarget instanceof Node) ||
        !menu?.contains(event.relatedTarget)
      )
    ) {
      scheduleMenuClose();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && menu && !menu.hidden) {
      const target = menuTarget;
      closeMenu();
      target?.focus();
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      if (
        menuTarget &&
        menu &&
        !menu.hidden &&
        document.contains(menuTarget)
      ) {
        positionMenu(menuTarget);
      }
    },
    {capture: true, passive: true}
  );
  window.addEventListener("resize", () => {
    if (menuTarget) {
      positionMenu(menuTarget);
    }
  });

  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message?.type === GET_EXPORT_STATE) {
        sendResponse(getExportState());
        return;
      }

      if (message?.type !== EXPORT_CONVERSATION) {
        return;
      }

      handleExportRequest(message)
        .then(sendResponse)
        .catch(error => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "导出对话失败。"
          });
        });
      return true;
    }
  );

  const pageObserver = new MutationObserver(
    scheduleRenderedScan
  );
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener(DATA_EVENT, handleConversationData);
  window.addEventListener("popstate", scheduleRenderedScan);
  scheduleRenderedScan();
})();
