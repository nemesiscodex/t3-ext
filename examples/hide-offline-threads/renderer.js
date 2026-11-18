{
  const LOG = "[hide-offline-threads]";
  const ROWS = "li[data-thread-item]";
  const MARK = "data-hide-offline-threads";
  const KEPT_SHELVES = new Set(["snoozed", "settled"]);

  const warned = new Set();
  function warnOnce(message) {
    if (!warned.has(message)) console.warn(LOG, message);
    warned.add(message);
  }

  let offline = new Set();

  // Only rows this extension hid are shown again, so a row T3 hid stays hidden.
  function setHidden(element, hide) {
    if (hide === element.hasAttribute(MARK)) return;
    if (hide) {
      if (element.hasAttribute("hidden")) return;
      element.setAttribute(MARK, "");
      element.setAttribute("hidden", "");
    } else {
      element.removeAttribute(MARK);
      element.removeAttribute("hidden");
    }
  }

  function apply() {
    const rows = ext.t3.threadRows();
    const environments = ext.t3.environments.get();
    // Before React renders, there are no rows and no environments yet.
    if (!environments && rows.length) warnOnce("could not read T3's linked environments; every thread shows");
    offline = new Set((environments ?? []).filter((environment) => environment.disconnected).map((environment) => environment.environmentId));
    const open = ext.t3.openThread();
    const hide = new Set();
    for (const row of rows) {
      const isOpen = open?.environmentId === row.environmentId && open.threadId === row.threadId;
      if (offline.has(row.environmentId) && !KEPT_SHELVES.has(row.shelf) && !isOpen) hide.add(row.element);
    }
    for (const element of document.querySelectorAll(`li[${MARK}]`)) if (!hide.has(element)) setHidden(element, false);
    for (const element of hide) setHidden(element, true);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      try {
        apply();
      } catch (error) {
        console.error(LOG, error);
      }
    });
  }

  // A row changes shelf in place when T3 snoozes or settles it, so its shelf attribute counts too.
  const isRow = (node) => node.nodeType === 1 && node.matches(ROWS);
  const touchesRows = (mutation) =>
    mutation.type === "attributes" ||
    !!mutation.target.closest?.(ROWS) ||
    (mutation.target.nodeName === "UL" && [...mutation.target.children].some(isRow)) ||
    [...mutation.addedNodes].some((node) => isRow(node) || (node.nodeType === 1 && !!node.querySelector(ROWS)));
  new MutationObserver((mutations) => {
    if (mutations.some(touchesRows)) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sidebar-parent"] });

  ext.t3.environments.subscribe(schedule);
  addEventListener("hashchange", schedule);

  window.t3HideOfflineThreads = {
    get disconnected() {
      return [...offline];
    },
    get hidden() {
      return [...document.querySelectorAll(`li[${MARK}]`)].map((element) => element.getAttribute("data-thread-item"));
    },
  };

  schedule();
}
