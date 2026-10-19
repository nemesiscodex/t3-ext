if (!window.__t3extManager) {
  window.__t3extManager = true;

  const api = window.t3ext;
  const PUZZLE_PATH =
    '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"></path>';
  const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";
  const pending = { reload: false, restart: false };
  let overlay = null;
  let opener = null;

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
      el("div", { className: "t3ext-row-actions" }, remove, toggle),
    );
  }

  async function render() {
    if (!overlay) return;
    const list = overlay.querySelector(".t3ext-list");
    let extensions;
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

  function close() {
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
      close();
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
    const dialog = el(
      "div",
      { className: "t3ext-dialog", role: "dialog", tabindex: "-1", "aria-modal": "true", "aria-labelledby": "t3ext-title" },
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
    const root = el("div", { className: "t3ext-overlay", "data-t3ext-manager": true }, dialog);
    root.addEventListener("mousedown", (event) => {
      if (event.target === root) close();
    });
    return root;
  }

  async function open() {
    if (!api) return;
    overlay ??= build();
    if (!overlay.isConnected) {
      opener = document.activeElement;
      document.body.append(overlay);
      window.addEventListener("keydown", onKeydown, true);
    }
    await render();
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
  window.addEventListener("t3ext:manage", open);
  schedule();
}
