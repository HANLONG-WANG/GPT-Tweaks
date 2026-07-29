(() => {
  "use strict";

  const NAVIGATION_ID = "gpt-tweaks-conversation-navigation";
  const DATA_EVENT = "gpt-tweaks:conversation-data";
  const SETTINGS_KEY = "navigationHistoryLimit";
  const TURN_SELECTOR =
    "section[data-turn][data-turn-id], " +
    "section[data-turn][data-turn-id-container]";
  const NATIVE_ITEM_SELECTOR =
    "button[data-toc-item-index], button[aria-label^='Prompt ']";
  const RANGE_OPTIONS = new Set([
    "auto",
    "25",
    "50",
    "100",
    "all"
  ]);
  const AUTO_LIMIT = 100;
  const JUMP_TIMEOUT = 8000;

  let activeItemId = "";
  let activeConversationId = "";
  let activeObserver = null;
  let bridgeConversationId = "";
  let currentNodeId = "";
  let fullItems = [];
  let historyLimit = "auto";
  let jumpSequence = 0;
  let modelNodes = new Map();
  let navigationRoot = null;
  let navigationTrack = null;
  let navigationViewport = null;
  let popoverList = null;
  let refreshFrame = 0;
  let resizeObserver = null;
  let scrollFrame = 0;
  let scrollTarget = null;
  let visibleItems = [];
  let closeTimer = 0;

  /**
   * Escape a value for use inside an attribute selector.
   *
   * @param {string} value
   * @returns {string}
   */
  function escapeSelector(value) {
    return CSS.escape(value);
  }

  /**
   * Return the conversation identifier from the current route.
   *
   * @returns {string}
   */
  function getRouteConversationId() {
    return location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? "";
  }

  /**
   * Determine whether an element is visibly rendered.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  /**
   * Leave ChatGPT's own table of contents untouched when it is available.
   *
   * @returns {boolean}
   */
  function hasNativeNavigation() {
    return [...document.querySelectorAll(NATIVE_ITEM_SELECTOR)].some(
      element =>
        !element.closest(`#${NAVIGATION_ID}`) &&
        isVisible(element)
    );
  }

  /**
   * Find the conversation's actual vertical scrolling element.
   *
   * @returns {HTMLElement | Window}
   */
  function findScrollTarget() {
    let element = document.querySelector("#thread")?.parentElement;

    while (element) {
      const overflowY = getComputedStyle(element).overflowY;

      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        element.scrollHeight > element.clientHeight
      ) {
        return element;
      }

      element = element.parentElement;
    }

    return window;
  }

  /**
   * Read a compact prompt label from a rendered user turn.
   *
   * @param {HTMLElement} turn
   * @param {number} index
   * @returns {string}
   */
  function readRenderedLabel(turn, index) {
    const message =
      turn.querySelector("[data-message-author-role='user']") ??
      turn;
    const text = (message.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (text) {
      const characters = [...text];

      return characters.length > 200
        ? `${characters.slice(0, 197).join("")}...`
        : text;
    }

    return turn.querySelector("img")
      ? "Image upload"
      : `提问 ${index + 1}`;
  }

  /**
   * Build prompt groups from stable rendered turn shells.
   *
   * @returns {Array<object>}
   */
  function buildDomItems() {
    const items = [];
    const turns = [...document.querySelectorAll(TURN_SELECTOR)]
      .filter(turn => turn instanceof HTMLElement);

    for (const turn of turns) {
      const turnId =
        turn.dataset.turnId ??
        turn.dataset.turnIdContainer ??
        "";
      const role = turn.dataset.turn ?? "";

      if (!turnId) {
        continue;
      }

      if (role === "user") {
        items.push({
          id: turnId,
          turnId,
          messageId:
            turn.querySelector("[data-message-id]")?.getAttribute(
              "data-message-id"
            ) ?? "",
          label: readRenderedLabel(turn, items.length),
          activeTurnIds: [turnId]
        });
        continue;
      }

      items.at(-1)?.activeTurnIds.push(turnId);
    }

    return items;
  }

  /**
   * Walk from current_node to the root so branches not on the active path do
   * not become navigation items.
   *
   * @returns {Array<object>}
   */
  function buildModelItems() {
    if (!currentNodeId || modelNodes.size === 0) {
      return [];
    }

    const path = [];
    const visited = new Set();
    let node = modelNodes.get(currentNodeId);

    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      path.push(node);
      node = node.parent
        ? modelNodes.get(node.parent)
        : null;
    }

    path.reverse();

    const items = [];
    for (const pathNode of path) {
      if (pathNode.role === "user") {
        items.push({
          id: pathNode.id,
          turnId: pathNode.id,
          messageId: pathNode.messageId,
          label: pathNode.label,
          activeTurnIds: [pathNode.id]
        });
        continue;
      }

      items.at(-1)?.activeTurnIds.push(pathNode.id);
    }

    return items;
  }

  /**
   * Prefer the complete conversation branch, but keep the DOM path as a
   * fallback when ChatGPT changes its response model.
   *
   * @returns {Array<object>}
   */
  function collectItems() {
    const modelItems = buildModelItems();
    const domItems = buildDomItems();

    if (modelItems.length === 0) {
      return domItems;
    }

    const domById = new Map(domItems.map(item => [item.id, item]));

    const mergedItems = modelItems.map(item => {
      const rendered = domById.get(item.id);

      return rendered
        ? {
            ...item,
            messageId: item.messageId || rendered.messageId,
            label: item.label || rendered.label,
            activeTurnIds: [
              ...new Set([
                ...item.activeTurnIds,
                ...rendered.activeTurnIds
              ])
            ]
          }
        : item;
    });
    const mergedIds = new Set(
      mergedItems.map(item => item.id)
    );

    domItems.forEach((domItem, domIndex) => {
      if (mergedIds.has(domItem.id)) {
        return;
      }

      const nextKnownDomItem = domItems
        .slice(domIndex + 1)
        .find(candidate => mergedIds.has(candidate.id));
      const insertionIndex = nextKnownDomItem
        ? mergedItems.findIndex(
            candidate => candidate.id === nextKnownDomItem.id
          )
        : mergedItems.length;

      mergedItems.splice(insertionIndex, 0, domItem);
      mergedIds.add(domItem.id);
    });

    return mergedItems.map((item, index) => ({
      ...item,
      label: item.label || `提问 ${index + 1}`
    }));
  }

  /**
   * Apply the selected history range to the complete item collection.
   *
   * @param {Array<object>} items
   * @returns {Array<object>}
   */
  function limitItems(items) {
    if (historyLimit === "all") {
      return items;
    }

    const limit =
      historyLimit === "auto"
        ? AUTO_LIMIT
        : Number.parseInt(historyLimit, 10);

    return items.length > limit
      ? items.slice(-limit)
      : items;
  }

  /**
   * Return a rendered element for an item without retaining a stale DOM
   * reference.
   *
   * @param {object} item
   * @returns {HTMLElement | null}
   */
  function findItemElement(item) {
    const selectors = [];

    if (item.turnId) {
      const turnId = escapeSelector(item.turnId);
      selectors.push(
        `[data-turn-id-container="${turnId}"]`,
        `[data-turn-id="${turnId}"]`
      );
    }

    if (item.messageId) {
      selectors.push(
        `[data-message-id="${escapeSelector(item.messageId)}"]`
      );
    }

    const element = selectors.length
      ? document.querySelector(selectors.join(","))
      : null;

    return element instanceof HTMLElement ? element : null;
  }

  /**
   * Scroll a target using the same stable identifiers used by ChatGPT.
   *
   * @param {HTMLElement} target
   */
  function scrollToTarget(target) {
    target.scrollIntoView({
      behavior: window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
        ? "auto"
        : "smooth",
      block: "start"
    });
  }

  /**
   * Display temporary loading feedback inside the expanded menu.
   *
   * @param {string} message
   */
  function setStatus(message) {
    const status = navigationRoot?.querySelector(
      ".gpt-tweaks-navigation-status"
    );

    if (status instanceof HTMLElement) {
      status.textContent = message;
      status.hidden = !message;
    }
  }

  /**
   * Ask ChatGPT's own paginator or virtual scroller to materialize a missing
   * target, then retry by UUID.
   *
   * @param {object} item
   * @param {number} fullIndex
   */
  async function jumpToItem(item, fullIndex) {
    const sequence = ++jumpSequence;
    const conversationId = getRouteConversationId();
    const immediateTarget = findItemElement(item);

    if (immediateTarget) {
      scrollToTarget(immediateTarget);
      closeNavigation();
      return;
    }

    setStatus("正在加载该对话节点…");

    const owner = findScrollTarget();
    const maximumScroll =
      owner instanceof HTMLElement
        ? owner.scrollHeight - owner.clientHeight
        : document.documentElement.scrollHeight -
          window.innerHeight;
    const ratio =
      fullItems.length > 1
        ? fullIndex / (fullItems.length - 1)
        : 0;
    const approximateTop = Math.max(
      0,
      Math.round(maximumScroll * ratio)
    );

    if (owner instanceof HTMLElement) {
      owner.scrollTo({top: approximateTop, behavior: "auto"});
    } else {
      window.scrollTo({top: approximateTop, behavior: "auto"});
    }

    const deadline = performance.now() + JUMP_TIMEOUT;
    let lastPaginationAttempt = 0;

    while (
      sequence === jumpSequence &&
      getRouteConversationId() === conversationId &&
      performance.now() < deadline
    ) {
      const target = findItemElement(item);

      if (target) {
        scrollToTarget(target);
        setStatus("");
        closeNavigation();
        return;
      }

      const now = performance.now();
      const sentinel = document.querySelector(
        '[data-testid="conversation-pagination-sentinel"]'
      );

      if (
        sentinel instanceof HTMLElement &&
        now - lastPaginationAttempt > 800
      ) {
        sentinel.scrollIntoView({
          behavior: "auto",
          block: "start"
        });
        lastPaginationAttempt = now;
      }

      await new Promise(resolve => {
        setTimeout(resolve, 100);
      });
    }

    if (
      sequence === jumpSequence &&
      getRouteConversationId() === conversationId
    ) {
      setStatus("暂时无法加载该节点，请滚动历史后重试。");
    }
  }

  /**
   * Calculate the active prompt from rendered turn shells at the viewport
   * center, matching ChatGPT's center-line observer.
   */
  function updateActiveFromGeometry() {
    scrollFrame = 0;

    if (fullItems.length === 0) {
      return;
    }

    const ownerRect =
      scrollTarget instanceof HTMLElement
        ? scrollTarget.getBoundingClientRect()
        : {top: 0, height: window.innerHeight};
    const center = ownerRect.top + ownerRect.height / 2;
    const itemByTurnId = new Map();

    fullItems.forEach(item => {
      item.activeTurnIds.forEach(turnId => {
        itemByTurnId.set(turnId, item);
      });
    });

    let nearestItem = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const turn of document.querySelectorAll(TURN_SELECTOR)) {
      if (!(turn instanceof HTMLElement)) {
        continue;
      }

      const turnId =
        turn.dataset.turnId ??
        turn.dataset.turnIdContainer ??
        "";
      const item = itemByTurnId.get(turnId);
      if (!item) {
        continue;
      }

      const rect = turn.getBoundingClientRect();
      const distance =
        center < rect.top
          ? rect.top - center
          : center > rect.bottom
            ? center - rect.bottom
            : 0;

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestItem = item;
      }
    }

    if (nearestItem) {
      setActiveItem(nearestItem.id);
    }
  }

  /**
   * Coalesce scroll work into an animation frame.
   */
  function scheduleActiveUpdate() {
    if (!scrollFrame) {
      scrollFrame = requestAnimationFrame(
        updateActiveFromGeometry
      );
    }
  }

  /**
   * Observe the narrow center band used by ChatGPT to change active turns.
   */
  function rebuildActiveObserver() {
    activeObserver?.disconnect();
    activeObserver = new IntersectionObserver(
      entries => {
        const ownerRect =
          scrollTarget instanceof HTMLElement
            ? scrollTarget.getBoundingClientRect()
            : {top: 0, height: window.innerHeight};
        const center =
          ownerRect.top + ownerRect.height / 2;
        const intersecting = entries
          .filter(entry => entry.isIntersecting)
          .sort((left, right) => {
            const leftCenter =
              left.boundingClientRect.top +
              left.boundingClientRect.height / 2;
            const rightCenter =
              right.boundingClientRect.top +
              right.boundingClientRect.height / 2;

            return (
              Math.abs(leftCenter - center) -
              Math.abs(rightCenter - center)
            );
          });
        const target = intersecting[0]?.target;

        if (!(target instanceof HTMLElement)) {
          return;
        }

        const turnId =
          target.dataset.turnId ??
          target.dataset.turnIdContainer ??
          "";
        const item = fullItems.find(candidate =>
          candidate.activeTurnIds.includes(turnId)
        );

        if (item) {
          setActiveItem(item.id);
        }
      },
      {
        root:
          scrollTarget instanceof HTMLElement
            ? scrollTarget
            : null,
        rootMargin: "-49% 0px -49% 0px",
        threshold: 0
      }
    );

    document.querySelectorAll(TURN_SELECTOR).forEach(turn => {
      activeObserver.observe(turn);
    });

    scheduleActiveUpdate();
  }

  /**
   * Move the clipped bar track so the active entry remains visible.
   */
  function positionTrack() {
    if (
      !navigationTrack ||
      !navigationViewport ||
      visibleItems.length === 0
    ) {
      return;
    }

    let index = visibleItems.findIndex(
      item => item.id === activeItemId
    );

    if (index < 0) {
      const activeFullIndex = fullItems.findIndex(
        item => item.id === activeItemId
      );
      const firstVisibleIndex = fullItems.findIndex(
        item => item.id === visibleItems[0]?.id
      );
      index =
        activeFullIndex >= 0 &&
        activeFullIndex < firstVisibleIndex
          ? 0
          : visibleItems.length - 1;
    }

    const firstButton = navigationTrack.querySelector("button");
    if (!(firstButton instanceof HTMLElement)) {
      return;
    }

    const trackStyle = getComputedStyle(navigationTrack);
    const gap = Number.parseFloat(trackStyle.rowGap) || 0;
    const paddingTop =
      Number.parseFloat(trackStyle.paddingTop) || 0;
    const itemHeight =
      firstButton.getBoundingClientRect().height;
    const itemCenter =
      paddingTop + index * (itemHeight + gap) + itemHeight / 2;
    const viewportHeight = navigationViewport.clientHeight;
    const minimumOffset = Math.min(
      0,
      viewportHeight - navigationTrack.scrollHeight
    );
    const offset = Math.min(
      0,
      Math.max(
        minimumOffset,
        viewportHeight / 2 - itemCenter
      )
    );

    navigationTrack.style.transform =
      `translate3d(0, ${offset}px, 0)`;
  }

  /**
   * Synchronize active styles in the collapsed and expanded views.
   *
   * @param {string} itemId
   */
  function setActiveItem(itemId) {
    if (!itemId || activeItemId === itemId) {
      return;
    }

    activeItemId = itemId;

    navigationRoot
      ?.querySelectorAll("[data-navigation-item-id]")
      .forEach(button => {
        const isActive =
          button.getAttribute("data-navigation-item-id") ===
          itemId;
        button.classList.toggle("is-active", isActive);

        if (isActive) {
          button.setAttribute("aria-current", "true");
        } else {
          button.removeAttribute("aria-current");
        }
      });

    positionTrack();

    if (navigationRoot?.classList.contains("is-open")) {
      const activeButton = popoverList?.querySelector(
        `[data-navigation-item-id="${escapeSelector(itemId)}"]`
      );
      activeButton?.scrollIntoView({block: "nearest"});
    }
  }

  /**
   * Open immediately on hover or keyboard focus.
   */
  function openNavigation() {
    if (!navigationRoot) {
      return;
    }

    window.clearTimeout(closeTimer);
    closeTimer = 0;
    navigationRoot.classList.add("is-open");
    navigationRoot.setAttribute("aria-expanded", "true");

    requestAnimationFrame(() => {
      const activeButton = popoverList?.querySelector(
        ".is-active"
      );
      activeButton?.scrollIntoView({block: "nearest"});
    });
  }

  /**
   * Close after the same grace period used by ChatGPT's navigator.
   */
  function scheduleCloseNavigation() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeNavigation();
    }, 250);
  }

  /**
   * Close the expanded menu unless focus is still inside it.
   */
  function closeNavigation() {
    if (!navigationRoot) {
      return;
    }

    window.clearTimeout(closeTimer);
    closeTimer = 0;
    navigationRoot.classList.remove("is-open");
    navigationRoot.setAttribute("aria-expanded", "false");
  }

  /**
   * Create one button for either the bar track or the text list.
   *
   * @param {object} item
   * @param {number} fullIndex
   * @param {boolean} expanded
   * @returns {HTMLButtonElement}
   */
  function createItemButton(item, fullIndex, expanded) {
    const button = document.createElement("button");

    button.type = "button";
    button.dataset.navigationItemId = item.id;
    button.className = expanded
      ? "gpt-tweaks-navigation-menu-item"
      : "gpt-tweaks-navigation-bar";
    button.setAttribute(
      "aria-label",
      expanded
        ? item.label
        : `跳转到提问 ${fullIndex + 1}`
    );

    if (expanded) {
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(label);
    }

    button.addEventListener("click", () => {
      void jumpToItem(item, fullIndex);
    });

    return button;
  }

  /**
   * Render the custom navigator from current metadata.
   */
  function renderNavigation() {
    removeNavigation();

    navigationRoot = document.createElement("aside");
    navigationRoot.id = NAVIGATION_ID;
    navigationRoot.setAttribute(
      "aria-label",
      "对话节点导航"
    );
    navigationRoot.setAttribute("aria-expanded", "false");
    navigationRoot.addEventListener(
      "mouseenter",
      openNavigation
    );
    navigationRoot.addEventListener(
      "mouseleave",
      scheduleCloseNavigation
    );
    navigationRoot.addEventListener("focusin", event => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(":focus-visible")
      ) {
        openNavigation();
      }
    });
    navigationRoot.addEventListener("focusout", event => {
      const nextTarget = event.relatedTarget;

      if (
        !(nextTarget instanceof Node) ||
        !navigationRoot?.contains(nextTarget)
      ) {
        scheduleCloseNavigation();
      }
    });

    navigationViewport = document.createElement("div");
    navigationViewport.className =
      "gpt-tweaks-navigation-viewport";

    navigationTrack = document.createElement("div");
    navigationTrack.className =
      "gpt-tweaks-navigation-track";

    const popover = document.createElement("div");
    popover.className = "gpt-tweaks-navigation-popover";

    popoverList = document.createElement("div");
    popoverList.className = "gpt-tweaks-navigation-list";
    popoverList.setAttribute("role", "list");

    visibleItems.forEach(item => {
      const fullIndex = fullItems.findIndex(
        candidate => candidate.id === item.id
      );
      navigationTrack?.append(
        createItemButton(item, fullIndex, false)
      );

      const menuButton = createItemButton(
        item,
        fullIndex,
        true
      );
      menuButton.setAttribute("role", "listitem");
      popoverList?.append(menuButton);
    });

    const status = document.createElement("div");
    status.className = "gpt-tweaks-navigation-status";
    status.setAttribute("role", "status");
    status.hidden = true;

    navigationViewport.append(navigationTrack);
    popover.append(popoverList, status);
    navigationRoot.append(navigationViewport, popover);
    document.body.append(navigationRoot);

    if (activeItemId) {
      const currentId = activeItemId;
      activeItemId = "";
      setActiveItem(currentId);
    }

    resizeObserver = new ResizeObserver(positionTrack);
    resizeObserver.observe(navigationViewport);
    resizeObserver.observe(navigationTrack);
    positionTrack();
  }

  /**
   * Update the scroll listener when ChatGPT replaces its thread container.
   */
  function updateScrollTarget() {
    const nextTarget = findScrollTarget();

    if (nextTarget === scrollTarget) {
      return false;
    }

    scrollTarget?.removeEventListener(
      "scroll",
      scheduleActiveUpdate
    );
    scrollTarget = nextTarget;
    scrollTarget.addEventListener(
      "scroll",
      scheduleActiveUpdate,
      {passive: true}
    );
    return true;
  }

  /**
   * Remove only the rendered navigator; collected model metadata remains
   * available if the native navigator later disappears.
   */
  function removeNavigation() {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    resizeObserver?.disconnect();
    resizeObserver = null;
    activeObserver?.disconnect();
    activeObserver = null;
    scrollTarget?.removeEventListener(
      "scroll",
      scheduleActiveUpdate
    );
    scrollTarget = null;
    navigationRoot?.remove();
    navigationRoot = null;
    navigationTrack = null;
    navigationViewport = null;
    popoverList = null;
  }

  /**
   * Reconcile metadata and UI after route, stream or pagination changes.
   */
  function refreshNavigation() {
    refreshFrame = 0;

    const routeConversationId = getRouteConversationId();
    if (!routeConversationId || !document.querySelector("#thread")) {
      removeNavigation();
      activeConversationId = "";
      fullItems = [];
      visibleItems = [];
      activeItemId = "";
      return;
    }

    if (activeConversationId !== routeConversationId) {
      activeConversationId = routeConversationId;
      jumpSequence += 1;
      activeItemId = "";
      fullItems = [];
      visibleItems = [];
    }

    if (
      bridgeConversationId &&
      bridgeConversationId !== routeConversationId
    ) {
      bridgeConversationId = "";
      currentNodeId = "";
      modelNodes.clear();
    }

    if (hasNativeNavigation()) {
      removeNavigation();
      return;
    }

    const nextFullItems = collectItems();
    const nextVisibleItems = limitItems(nextFullItems);
    const signature = items =>
      items
        .map(
          item =>
            `${item.id}:${item.messageId}:${item.label}:` +
            item.activeTurnIds.join(",")
        )
        .join("\n");
    const requiresRender =
      !navigationRoot ||
      signature(nextVisibleItems) !== signature(visibleItems);

    fullItems = nextFullItems;
    visibleItems = nextVisibleItems;

    if (visibleItems.length === 0) {
      removeNavigation();
      return;
    }

    if (requiresRender) {
      renderNavigation();
    }

    const targetChanged = updateScrollTarget();
    if (requiresRender || targetChanged) {
      rebuildActiveObserver();
    } else {
      scheduleActiveUpdate();
    }
  }

  /**
   * Coalesce ChatGPT's frequent streaming mutations.
   */
  function scheduleRefresh() {
    if (!refreshFrame) {
      refreshFrame = requestAnimationFrame(
        refreshNavigation
      );
    }
  }

  /**
   * Merge sanitized conversation metadata emitted by the main-world bridge.
   *
   * @param {Event} event
   */
  function handleConversationData(event) {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail !== "string"
    ) {
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
    if (
      payload.conversationId &&
      routeConversationId &&
      payload.conversationId !== routeConversationId
    ) {
      return;
    }

    if (
      bridgeConversationId &&
      payload.conversationId &&
      bridgeConversationId !== payload.conversationId
    ) {
      modelNodes.clear();
    }

    bridgeConversationId =
      payload.conversationId || routeConversationId;
    currentNodeId =
      typeof payload.currentNode === "string"
        ? payload.currentNode
        : currentNodeId;

    for (const node of payload.nodes) {
      if (
        !node ||
        typeof node !== "object" ||
        typeof node.id !== "string"
      ) {
        continue;
      }

      modelNodes.set(node.id, {
        id: node.id,
        parent:
          typeof node.parent === "string"
            ? node.parent
            : null,
        role:
          typeof node.role === "string" ? node.role : "",
        messageId:
          typeof node.messageId === "string"
            ? node.messageId
            : "",
        label:
          typeof node.label === "string" ? node.label : ""
      });
    }

    scheduleRefresh();
  }

  const pageObserver = new MutationObserver(scheduleRefresh);
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener(DATA_EVENT, handleConversationData);
  window.addEventListener("resize", scheduleRefresh, {
    passive: true
  });
  window.addEventListener("popstate", scheduleRefresh);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const nextValue = changes[SETTINGS_KEY]?.newValue;

    if (
      areaName === "local" &&
      RANGE_OPTIONS.has(nextValue) &&
      nextValue !== historyLimit
    ) {
      historyLimit = nextValue;
      scheduleRefresh();
    }
  });

  chrome.storage.local.get(
    {[SETTINGS_KEY]: "auto"},
    stored => {
      const value = stored[SETTINGS_KEY];
      historyLimit = RANGE_OPTIONS.has(value)
        ? value
        : "auto";
      scheduleRefresh();
    }
  );
})();
