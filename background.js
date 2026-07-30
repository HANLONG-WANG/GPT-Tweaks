(() => {
  "use strict";

  const SAVE_MARKDOWN = "gpt-tweaks:save-markdown";
  const MAX_MARKDOWN_LENGTH = 50 * 1024 * 1024;

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
    const base = filename || "ChatGPT 对话";
    const withExtension = base.toLowerCase().endsWith(".md")
      ? base
      : `${base}.md`;
    const characters = [...withExtension];

    return (
      characters.length > 180
        ? `${characters.slice(0, 177).join("").trim()}.md`
        : withExtension
    ) || "ChatGPT 对话.md";
  }

  /**
   * @param {object} message
   * @param {chrome.runtime.MessageSender} sender
   * @returns {Promise<object>}
   */
  async function saveMarkdown(message, sender) {
    if (sender.id !== chrome.runtime.id) {
      throw new Error("拒绝了未知来源的下载请求。");
    }

    if (
      typeof message.markdown !== "string" ||
      message.markdown.length === 0
    ) {
      throw new Error("没有可下载的 Markdown 内容。");
    }

    if (message.markdown.length > MAX_MARKDOWN_LENGTH) {
      throw new Error("导出内容超过 50 MB，无法安全下载。");
    }

    const filename = sanitizeFilename(
      typeof message.filename === "string"
        ? message.filename
        : "ChatGPT 对话.md"
    );
    const url =
      "data:text/markdown;charset=utf-8," +
      encodeURIComponent(`\uFEFF${message.markdown}`);
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: true
    });

    return {ok: true, downloadId};
  }

  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      if (message?.type !== SAVE_MARKDOWN) {
        return;
      }

      saveMarkdown(message, sender)
        .then(sendResponse)
        .catch(error => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "无法启动 Markdown 下载。"
          });
        });
      return true;
    }
  );
})();
