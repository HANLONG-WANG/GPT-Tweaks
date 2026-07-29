(() => {
  "use strict";

  const SETTINGS_KEY = "navigationHistoryLimit";
  const VALID_VALUES = new Set([
    "auto",
    "25",
    "50",
    "100",
    "all"
  ]);
  const select = document.querySelector("#history-limit");
  const status = document.querySelector("#status");
  let statusTimer = 0;

  /**
   * Show a short confirmation without requiring the popup to close.
   *
   * @param {string} message
   */
  function showStatus(message) {
    window.clearTimeout(statusTimer);
    status.textContent = message;
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, 1500);
  }

  chrome.storage.local.get(
    {[SETTINGS_KEY]: "auto"},
    stored => {
      const value = stored[SETTINGS_KEY];
      select.value = VALID_VALUES.has(value)
        ? value
        : "auto";
    }
  );

  select.addEventListener("change", () => {
    if (!VALID_VALUES.has(select.value)) {
      return;
    }

    chrome.storage.local.set(
      {[SETTINGS_KEY]: select.value},
      () => {
        showStatus("设置已保存");
      }
    );
  });
})();
