(() => {
  "use strict";

  const SETTINGS_KEY = "navigationHistoryLimit";
  const GET_EXPORT_STATE = "gpt-tweaks:get-export-state";
  const EXPORT_CONVERSATION =
    "gpt-tweaks:export-conversation";
  const VALID_VALUES = new Set([
    "auto",
    "25",
    "50",
    "100",
    "all"
  ]);

  const historySelect = document.querySelector("#history-limit");
  const settingsStatus = document.querySelector("#status");
  const exportLoading = document.querySelector("#export-loading");
  const exportControls = document.querySelector("#export-controls");
  const exportStatus = document.querySelector("#export-status");
  const sessionTitle = document.querySelector("#session-title");
  const roundSelection = document.querySelector("#round-selection");
  const roundList = document.querySelector("#round-list");
  const selectionCount = document.querySelector("#selection-count");
  const selectAllButton = document.querySelector("#select-all");
  const selectNoneButton = document.querySelector("#select-none");
  const copyButton = document.querySelector("#copy-export");
  const downloadButton = document.querySelector(
    "#download-export"
  );
  const modeInputs = [
    ...document.querySelectorAll(
      'input[name="export-mode"]'
    )
  ];

  let activeTabId = null;
  let settingsStatusTimer = 0;
  let exportStatusTimer = 0;

  /**
   * @param {HTMLElement} element
   * @param {string} message
   * @param {"success" | "error"} type
   * @param {number} duration
   */
  function showStatus(
    element,
    message,
    type = "success",
    duration = 2200
  ) {
    const isSettings = element === settingsStatus;
    const timer = isSettings
      ? settingsStatusTimer
      : exportStatusTimer;

    window.clearTimeout(timer);
    element.dataset.type = type;
    element.textContent = message;

    const nextTimer = window.setTimeout(() => {
      element.textContent = "";
      delete element.dataset.type;
    }, duration);

    if (isSettings) {
      settingsStatusTimer = nextTimer;
    } else {
      exportStatusTimer = nextTimer;
    }
  }

  /**
   * @returns {"all" | "selected"}
   */
  function getExportMode() {
    return (
      modeInputs.find(input => input.checked)?.value ===
      "selected"
        ? "selected"
        : "all"
    );
  }

  /**
   * @returns {Array<HTMLInputElement>}
   */
  function getRoundCheckboxes() {
    return [
      ...roundList.querySelectorAll(
        'input[type="checkbox"][data-round-id]'
      )
    ];
  }

  /**
   * Update the selected-round counter and action availability.
   */
  function updateSelectionState() {
    const checked = getRoundCheckboxes().filter(
      input => input.checked
    ).length;

    selectionCount.textContent = `已选择 ${checked} 轮`;
    const selectionRequired =
      getExportMode() === "selected" && checked === 0;
    copyButton.disabled = selectionRequired;
    downloadButton.disabled = selectionRequired;
  }

  /**
   * Show or hide the round checklist for the selected mode.
   */
  function updateMode() {
    roundSelection.hidden = getExportMode() !== "selected";
    updateSelectionState();
  }

  /**
   * @param {Array<object>} nextRounds
   */
  function renderRounds(nextRounds) {
    roundList.replaceChildren();

    nextRounds.forEach(round => {
      const label = document.createElement("label");
      label.className = "round-choice";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.roundId = round.id;
      checkbox.addEventListener("change", updateSelectionState);

      const labelBody = document.createElement("span");
      labelBody.className = "round-label";

      const title = document.createElement("span");
      title.textContent = `第 ${round.index} 轮 · ${round.label}`;
      title.title = round.label;
      labelBody.append(title);

      if (!round.hasAssistant) {
        const note = document.createElement("small");
        note.textContent = "本轮没有最终 AI 回复";
        labelBody.append(note);
      }

      label.append(checkbox, labelBody);
      roundList.append(label);
    });

    updateSelectionState();
  }

  /**
   * @param {object} message
   * @returns {Promise<object>}
   */
  function sendToActiveTab(message) {
    return new Promise((resolve, reject) => {
      if (!Number.isInteger(activeTabId)) {
        reject(new Error("无法识别当前标签页。"));
        return;
      }

      chrome.tabs.sendMessage(
        activeTabId,
        message,
        response => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve(response ?? {});
        }
      );
    });
  }

  /**
   * Read the active tab once when the popup opens.
   *
   * @returns {Promise<void>}
   */
  function resolveActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(
        {active: true, currentWindow: true},
        tabs => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          const tabId = tabs[0]?.id;
          if (!Number.isInteger(tabId)) {
            reject(new Error("无法识别当前标签页。"));
            return;
          }

          activeTabId = tabId;
          resolve();
        }
      );
    });
  }

  /**
   * Load round descriptors without moving full conversation bodies into the
   * popup context.
   */
  async function loadExportState() {
    try {
      await resolveActiveTab();
      const response = await sendToActiveTab({
        type: GET_EXPORT_STATE
      });

      if (!response.ok) {
        throw new Error(
          response.error || "当前页面没有可导出的对话。"
        );
      }

      exportLoading.hidden = true;
      exportControls.hidden = false;
      sessionTitle.textContent =
        response.title || "当前 ChatGPT Session";
      sessionTitle.title = sessionTitle.textContent;
      renderRounds(
        Array.isArray(response.rounds)
          ? response.rounds
          : []
      );
    } catch (error) {
      exportLoading.dataset.type = "error";
      exportLoading.textContent =
        error instanceof Error
          ? error.message
          : "无法读取当前 Session。";
    }
  }

  /**
   * @returns {object}
   */
  function readExportOptions() {
    return {
      includeSystem:
        document.querySelector("#include-system").checked,
      includeTool:
        document.querySelector("#include-tool").checked,
      includeThoughts:
        document.querySelector("#include-thoughts").checked,
      includeReasoning:
        document.querySelector("#include-reasoning").checked,
      includeHidden:
        document.querySelector("#include-hidden").checked,
      includeOther:
        document.querySelector("#include-other").checked
    };
  }

  /**
   * @param {boolean} busy
   */
  function setExportBusy(busy) {
    const selectionRequired =
      getExportMode() === "selected" &&
      getRoundCheckboxes().every(input => !input.checked);

    copyButton.disabled = busy || selectionRequired;
    downloadButton.disabled = busy || selectionRequired;
    modeInputs.forEach(input => {
      input.disabled = busy;
    });
    getRoundCheckboxes().forEach(input => {
      input.disabled = busy;
    });
    selectAllButton.disabled = busy;
    selectNoneButton.disabled = busy;
  }

  /**
   * @param {"copy" | "download"} action
   */
  async function runExport(action) {
    const mode = getExportMode();
    const roundIds = getRoundCheckboxes()
      .filter(input => input.checked)
      .map(input => input.dataset.roundId);

    if (mode === "selected" && roundIds.length === 0) {
      showStatus(
        exportStatus,
        "请至少选择一个对话轮次。",
        "error"
      );
      return;
    }

    setExportBusy(true);
    showStatus(
      exportStatus,
      action === "copy"
        ? "正在生成并复制 Markdown…"
        : "正在生成 Markdown…",
      "success",
      10000
    );

    try {
      const response = await sendToActiveTab({
        type: EXPORT_CONVERSATION,
        action,
        mode,
        roundIds,
        options: readExportOptions()
      });

      if (!response.ok) {
        throw new Error(response.error || "导出对话失败。");
      }

      showStatus(
        exportStatus,
        action === "copy"
          ? `已复制 ${response.count} 轮对话`
          : "已打开另存为窗口"
      );
    } catch (error) {
      showStatus(
        exportStatus,
        error instanceof Error
          ? error.message
          : "导出对话失败。",
        "error",
        5000
      );
    } finally {
      setExportBusy(false);
    }
  }

  chrome.storage.local.get(
    {[SETTINGS_KEY]: "auto"},
    stored => {
      const value = stored[SETTINGS_KEY];
      historySelect.value = VALID_VALUES.has(value)
        ? value
        : "auto";
    }
  );

  historySelect.addEventListener("change", () => {
    if (!VALID_VALUES.has(historySelect.value)) {
      return;
    }

    chrome.storage.local.set(
      {[SETTINGS_KEY]: historySelect.value},
      () => {
        showStatus(settingsStatus, "设置已保存");
      }
    );
  });

  modeInputs.forEach(input => {
    input.addEventListener("change", updateMode);
  });

  selectAllButton.addEventListener("click", () => {
    getRoundCheckboxes().forEach(input => {
      input.checked = true;
    });
    updateSelectionState();
  });

  selectNoneButton.addEventListener("click", () => {
    getRoundCheckboxes().forEach(input => {
      input.checked = false;
    });
    updateSelectionState();
  });

  copyButton.addEventListener("click", () => {
    void runExport("copy");
  });
  downloadButton.addEventListener("click", () => {
    void runExport("download");
  });

  updateMode();
  void loadExportState();
})();
