if (!window.__t3extManager) {
  window.__t3extManager = true;

  const api = window.t3ext;
  const PUZZLE_PATH =
    '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"></path>';
  const BACK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';
  const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";
  const pending = { reload: false, restart: false };
  let overlay = null;
  let opener = null;
  let extensions = [];
  let settings = null; // { id, view, cleanup } while a settings panel is shown

  // Extensions register panels in the page itself: window.t3ext is frozen by the context bridge.
  const panels = () => (window.t3extSettings instanceof Map ? window.t3extSettings : new Map());

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "className") node.className = value;
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...children.flat().filter((child) => child != null && child !== false));
    return node;
  };

  const errorText = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  async function act(fn, { touchesMain = false } = {}) {
    try {
      if ((await fn()) === false) return;
      pending.reload = true;
      pending.restart ||= touchesMain;
    } catch (error) {
      alert(errorText(error));
    } finally {
      await render();
    }
  }

  function row(extension) {
    const { manifest, parts } = extension;
    const partNames = Object.keys(parts).filter((part) => parts[part]);
    const toggle = el(
      "button",
      {
        type: "button",
        role: "switch",
        className: "t3ext-switch",
        "aria-checked": String(extension.enabled),
        "aria-label": `${extension.enabled ? "Disable" : "Enable"} ${manifest?.name ?? extension.id}`,
        onClick: () => act(() => api.setEnabled(extension.id, !extension.enabled), { touchesMain: parts.main }),
      },
      el("span", { className: "t3ext-switch-thumb" }),
    );
    const remove = extension.builtin
      ? null
      : el(
          "button",
          {
            type: "button",
            className: "t3ext-button t3ext-button-danger",
            onClick: () => {
              if (confirm(`Move "${manifest?.name ?? extension.id}" to the Trash?`)) {
                act(() => api.remove(extension.id), { touchesMain: parts.main });
              }
            },
          },
          "Remove",
        );
    const openPanel =
      extension.enabled && typeof panels().get(extension.id) === "function"
        ? el("button", { type: "button", className: "t3ext-button t3ext-settings-button", onClick: () => openSettings(extension) }, "Settings")
        : null;
    return el(
      "li",
      { className: "t3ext-row", "data-extension-id": extension.id },
      el(
        "div",
        { className: "t3ext-row-main" },
        el(
          "div",
          { className: "t3ext-row-title" },
          el("span", { className: "t3ext-name" }, manifest?.name ?? extension.id),
          manifest?.version ? el("span", { className: "t3ext-version" }, `v${manifest.version}`) : null,
          extension.builtin ? el("span", { className: "t3ext-badge" }, "Built in") : null,
        ),
        manifest?.description ? el("p", { className: "t3ext-description" }, manifest.description) : null,
        el(
          "div",
          { className: "t3ext-meta" },
          el("button", { type: "button", className: "t3ext-id", title: "Open folder", onClick: () => api.openFolder(extension.id) }, extension.id),
          ...partNames.map((part) => el("span", { className: "t3ext-chip" }, part)),
        ),
        extension.error ? el("p", { className: "t3ext-error" }, extension.error) : null,
      ),
      el("div", { className: "t3ext-row-actions" }, openPanel, remove, toggle),
    );
  }

  async function render() {
    if (!overlay) return;
    const list = overlay.querySelector(".t3ext-list");
    try {
      extensions = await api.list();
    } catch (error) {
      list.replaceChildren(el("li", { className: "t3ext-error" }, errorText(error)));
      return;
    }
    const focusedRow = document.activeElement?.closest(".t3ext-list [data-extension-id]");
    const refocus = focusedRow && {
      id: focusedRow.dataset.extensionId,
      index: [...focusedRow.querySelectorAll(FOCUSABLE)].indexOf(document.activeElement),
    };
    list.replaceChildren(...extensions.map(row));
    if (refocus) {
      const same = [...list.children].find((item) => item.dataset.extensionId === refocus.id);
      (same?.querySelectorAll(FOCUSABLE)[refocus.index] ?? overlay.querySelector(".t3ext-dialog")).focus();
    }
    const notice = overlay.querySelector(".t3ext-notice");
    notice.hidden = !pending.reload;
    notice.querySelector(".t3ext-notice-text").textContent = pending.restart
      ? "Reload to apply. Changes to main.js apply after restarting T3 Code."
      : "Reload the window to apply your changes.";
  }

  // The settings view replaces the list in the same dialog, so the focus trap and Escape keep working.
  function openSettings(extension) {
    const renderPanel = panels().get(extension.id);
    if (typeof renderPanel !== "function") return;
    closeSettings(false);
    const dialog = overlay.querySelector(".t3ext-dialog");
    const back = el("button", { type: "button", className: "t3ext-icon-button t3ext-back", "aria-label": "Back to Extensions", title: "Back", onClick: () => closeSettings(true) });
    back.innerHTML = BACK_ICON;
    const container = el("div", { className: "t3ext-settings-body" });
    const view = el(
      "div",
      { className: "t3ext-view", "data-t3ext-settings": extension.id },
      el(
        "header",
        { className: "t3ext-header t3ext-settings-header" },
        back,
        el("h2", { id: "t3ext-settings-title" }, `${extension.manifest?.name ?? extension.id} settings`),
        el("button", { type: "button", className: "t3ext-icon-button t3ext-close", "aria-label": "Close", onClick: close }, "×"),
      ),
      container,
    );
    overlay.querySelector(".t3ext-view-main").hidden = true;
    dialog.append(view);
    dialog.setAttribute("aria-labelledby", "t3ext-settings-title");
    const shown = { id: extension.id, view, cleanup: null };
    settings = shown;
    try {
      const cleanup = renderPanel(container, { close: () => settings === shown && closeSettings(true) });
      if (typeof cleanup === "function") shown.cleanup = cleanup;
    } catch (error) {
      console.error("[t3ext]", extension.id, "settings panel failed", error);
      container.append(el("p", { className: "t3ext-error" }, errorText(error)));
    }
    (container.querySelector(FOCUSABLE) ?? back).focus();
  }

  function closeSettings(refocus) {
    if (!settings) return;
    const { id, view, cleanup } = settings;
    settings = null;
    try {
      cleanup?.();
    } catch (error) {
      console.error("[t3ext]", id, "settings panel cleanup failed", error);
    }
    view.remove();
    overlay.querySelector(".t3ext-view-main").hidden = false;
    const dialog = overlay.querySelector(".t3ext-dialog");
    dialog.setAttribute("aria-labelledby", "t3ext-title");
    if (refocus) (overlay.querySelector(`[data-extension-id="${CSS.escape(id)}"] .t3ext-settings-button`) ?? dialog).focus();
  }

  function close() {
    closeSettings(false);
    overlay.remove();
    window.removeEventListener("keydown", onKeydown, true);
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  // Window capture phase: the modal gets Escape and Tab even if focus slipped behind it,
  // and T3's own shortcuts do not see them while it is open.
  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (settings) closeSettings(true);
      else close();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = overlay.querySelector(".t3ext-dialog");
    const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => !node.closest("[hidden]"));
    if (focusable.length === 0) return;
    const active = document.activeElement;
    const inside = active !== dialog && dialog.contains(active);
    const edge = event.shiftKey ? focusable[0] : focusable.at(-1);
    if (!inside || active === edge) {
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0]).focus();
    }
  }

  function build() {
    const main = el(
      "div",
      { className: "t3ext-view t3ext-view-main" },
      el(
        "header",
        { className: "t3ext-header" },
        el("div", {}, el("h2", { id: "t3ext-title" }, "Extensions"), el("p", { className: "t3ext-subtitle" }, "Folders in your T3 extensions directory. Symlinks work.")),
        el("button", { type: "button", className: "t3ext-icon-button t3ext-close", "aria-label": "Close", onClick: close }, "×"),
      ),
      el(
        "div",
        { className: "t3ext-toolbar" },
        el("button", { type: "button", className: "t3ext-button", onClick: () =>
              act(async () => {
                const added = await api.add();
                if (!added) return false;
                pending.restart ||= added.parts.main;
              }),
          }, "Add from folder…"),
        el("button", { type: "button", className: "t3ext-button", onClick: () => api.openFolder() }, "Open folder"),
      ),
      el("ul", { className: "t3ext-list" }),
      el(
        "div",
        { className: "t3ext-notice", hidden: true },
        el("span", { className: "t3ext-notice-text" }),
        el("button", { type: "button", className: "t3ext-button t3ext-button-primary", onClick: () => location.reload() }, "Reload"),
      ),
    );
    const dialog = el("div", { className: "t3ext-dialog", role: "dialog", tabindex: "-1", "aria-modal": "true", "aria-labelledby": "t3ext-title" }, main);
    const root = el("div", { className: "t3ext-overlay", "data-t3ext-manager": true }, dialog);
    root.addEventListener("mousedown", (event) => {
      if (event.target === root) close();
    });
    return root;
  }

  // `settingsId` opens straight into that extension's settings panel, when it has one.
  async function open(settingsId) {
    if (!api) return;
    overlay ??= build();
    if (!overlay.isConnected) {
      opener = document.activeElement;
      document.body.append(overlay);
      window.addEventListener("keydown", onKeydown, true);
    }
    await render();
    const target = typeof settingsId === "string" ? extensions.find((extension) => extension.id === settingsId) : null;
    if (target?.enabled && typeof panels().get(target.id) === "function") return openSettings(target);
    closeSettings(false);
    overlay.querySelector(".t3ext-dialog").focus();
  }

  function ensureNavItem() {
    if (!location.hash.startsWith("#/settings")) return;
    for (const menu of document.querySelectorAll('ul[data-sidebar="menu"]')) {
      const items = [...menu.children].filter((item) => !item.hasAttribute("data-t3ext-nav"));
      if (!items.some((item) => item.textContent.trim() === "Appearance")) continue;
      if (menu.querySelector("[data-t3ext-nav]")) return;
      const item = items.at(-1).cloneNode(true);
      item.setAttribute("data-t3ext-nav", "");
      const button = item.querySelector("button, a");
      if (!button) return;
      button.setAttribute("data-active", "false");
      button.removeAttribute("aria-current");
      button.removeAttribute("href");
      const icon = button.querySelector("svg");
      if (icon) {
        icon.setAttribute("class", (icon.getAttribute("class") ?? "").replace(/lucide-[\w-]+/g, "").trim() + " lucide lucide-puzzle");
        icon.innerHTML = PUZZLE_PATH;
      }
      const label = [...button.querySelectorAll("span")].at(-1);
      if (label) label.textContent = "Extensions";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      });
      menu.append(item);
      return;
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      ensureNavItem();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", schedule);
  window.addEventListener("t3ext:manage", (event) => open(event.detail?.settings));
  schedule();
}
