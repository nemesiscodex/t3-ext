if (!window.t3StreamingMode) {
  const STORAGE_KEY = "t3ext.streaming-mode";
  const LOG = "[streaming-mode]";
  const TRIGGER = 'button[data-slot="combobox-trigger"][aria-label^="Filter threads by project"]';
  const THREAD_ROW = "[data-thread-item]";
  const MARK = "data-t3sm-blur";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GITHUB = "github.com/";
  const RECHECK_MS = 24 * 60 * 60 * 1000;
  const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
  const FILTER_FROM = 8;
  // T3's label for threads outside any project. It names nothing.
  const PLACEHOLDER = "No project";

  // A host older than per-extension config passes no id and has no getConfig. The extension then
  // keeps the one built-in profile and offers no profile menu or settings panel.
  const api = window.t3ext;
  const ID = typeof extensionId === "string" ? extensionId : null;
  const configurable = ID !== null && ["getConfig", "setConfig", "onConfigChange"].every((name) => typeof api?.[name] === "function");

  // From T3's bundle (lucide, ISC license).
  const ICONS = {
    eye: [["path", { d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
    "eye-off": [
      ["path", { d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" }],
      ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
      ["path", { d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" }],
      ["path", { d: "m2 2 20 20" }],
    ],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
  };

  // --- Profiles ---------------------------------------------------------------------------------

  // Kept by the host and shared by every window:
  // { version: 1, active: "<profile id>", profiles: [{ id, name, public, projects }] }
  // A project shows when its key is in `projects`, or when `public` is set and GitHub says its
  // repository is public. The default profile is the original behavior: public repositories only.
  const DEFAULT_CONFIG = { version: 1, active: "public", profiles: [{ id: "public", name: "Public repositories", public: true, projects: [] }] };

  function parseConfig(value) {
    const seen = new Set();
    const profiles = [];
    for (const profile of value?.version === 1 && Array.isArray(value.profiles) ? value.profiles : []) {
      if (typeof profile?.id !== "string" || !profile.id || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push({
        id: profile.id,
        name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : "Untitled profile",
        public: profile.public === true,
        projects: Array.isArray(profile.projects) ? [...new Set(profile.projects.filter((key) => typeof key === "string" && key))] : [],
      });
    }
    if (!profiles.length) return structuredClone(DEFAULT_CONFIG);
    return { version: 1, active: seen.has(value.active) ? value.active : profiles[0].id, profiles };
  }

  // null until the host answers. Nothing counts as visible then, so no name shows early.
  let config = configurable ? null : structuredClone(DEFAULT_CONFIG);
  const activeProfile = () => config?.profiles.find((profile) => profile.id === config.active) ?? null;
  const withProfile = (current, id, change) => ({ ...current, profiles: current.profiles.map((profile) => (profile.id === id ? change(profile) : profile)) });

  // Writes run one after another, each on the config the previous one produced, so quick changes
  // do not undo each other. Every window, this one too, applies the host's broadcast of the result.
  let writes = Promise.resolve();
  function updateConfig(change) {
    writes = writes
      .then(() => api.setConfig(ID, change(config)))
      .then(applyConfig)
      .catch((error) => console.error(LOG, "could not save profiles", error));
    return writes;
  }

  // --- Saved state ------------------------------------------------------------------------------

  // on:       streaming mode is on.
  // repos:    "github.com/owner/name" -> { public, checkedAt }, what GitHub said without a login.
  // projects: project key -> { label, detail, texts } for every project in T3's project list when
  //           it was last readable, so names stay blurred while the sidebar is collapsed.
  // threads:  "<environmentId>:<threadId>" -> { project, texts } for every thread seen in the
  //           sidebar, so its title stays blurred in the chat header after its row leaves.
  // Projects and threads are kept whatever their visibility, so a profile switch applies at once.
  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {}
    const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    const loaded = { version: 2, on: saved?.on === true, repos: record(saved?.repos), projects: {}, threads: {} };
    // Version 1 kept only the hidden names. The next sync fills projects and threads in.
    if (saved?.version === 2) Object.assign(loaded, { projects: record(saved.projects), threads: record(saved.threads) });
    return loaded;
  }

  let state = load();
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // "github.com/owner/name" for a project key on github.com, null for any other remote or none.
  const repoOf = (key) => (typeof key === "string" && key.startsWith(GITHUB) && key.split("/").length === 3 ? key : null);
  const isPublic = (repo) => repo !== null && state.repos[repo]?.public === true;
  const knownRepos = () => [...new Set(Object.keys(state.projects).map(repoOf).filter(Boolean))];

  function isVisible(key) {
    const profile = activeProfile();
    return Boolean(profile && typeof key === "string" && (profile.projects.includes(key) || (profile.public && isPublic(repoOf(key)))));
  }

  let secrets;
  let longest;
  function setSecrets() {
    const list = [
      ...Object.entries(state.projects).flatMap(([key, project]) => (isVisible(key) ? [] : project.texts)),
      ...Object.values(state.threads).flatMap((thread) => (isVisible(thread.project) ? [] : thread.texts)),
    ];
    secrets = new Set(list);
    longest = Math.max(0, ...list.map((text) => text.length));
  }
  setSecrets();

  // --- Reading T3 -------------------------------------------------------------------------------

  // A DOM node can still point at the fiber of the previous render, whose props are stale. The
  // one whose root is the root's `current` is the live one.
  function fiberOf(node) {
    const key = node && Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
    const fiber = key && node[key];
    if (!fiber) return null;
    let top = fiber;
    while (top.return) top = top.return;
    return top.stateNode?.current === top ? fiber : (fiber.alternate ?? fiber);
  }

  // The sidebar's memoized project catalog, found from T3's project filter button.
  function readCatalog(trigger) {
    for (let fiber = fiberOf(trigger), i = 0; fiber && i < 80; fiber = fiber.return, i++) {
      for (const cached of fiber.updateQueue?.memoCache?.data ?? []) {
        for (const value of Array.isArray(cached) ? cached : []) {
          if (Array.isArray(value?.projectGroups) && value.projectGroups.every((group) => Array.isArray(group?.memberProjects))) return value;
        }
      }
    }
    return null;
  }

  // Every clone and worktree of one repository shares its key, so picking it covers them all.
  const projectKey = (project) => project?.repositoryIdentity?.canonicalKey?.toLowerCase() || project?.workspaceRoot || null;

  const textsOf = (...values) =>
    [...new Set(values.filter((text) => typeof text === "string").map((text) => text.trim()).filter((text) => text && text !== PLACEHOLDER))].sort();

  // Every text T3 shows for each project: the sidebar name, the folder name, its path, its
  // repository's name, and the name of its sidebar group.
  function projectsOf(catalog) {
    const projects = {};
    for (const group of catalog.projectGroups) {
      for (const project of group.memberProjects) {
        const key = projectKey(project);
        if (!key) continue;
        const identity = project.repositoryIdentity;
        const known = projects[key] ?? { label: textsOf(identity?.displayName)[0] ?? textsOf(project.title)[0] ?? key, detail: project.workspaceRoot ?? "", texts: [] };
        known.texts = textsOf(...known.texts, project.title, project.workspaceRoot, identity?.displayName, identity?.canonicalKey, group.displayName);
        projects[key] = known;
      }
    }
    return projects;
  }

  // The thread and project each sidebar row renders from, null when T3 renamed what this reads.
  function readThreadRows() {
    const rows = [...document.querySelectorAll(THREAD_ROW)];
    const read = rows.flatMap((row) => {
      for (let fiber = fiberOf(row), i = 0; fiber && i < 4; fiber = fiber.return, i++) {
        const props = fiber.memoizedProps;
        if (props?.thread?.id && "project" in props) return [props];
      }
      return [];
    });
    return rows.length && !read.length ? null : read;
  }

  // The saved threads, updated with the rows on screen. A renamed thread's old title is replaced.
  function threadsOf(rows) {
    const threads = { ...state.threads };
    for (const { thread, project } of rows) {
      const key = `${thread.environmentId}:${thread.id}`;
      const texts = textsOf(thread.title, thread.branch);
      if (texts.length) threads[key] = { project: projectKey(project), texts };
      else delete threads[key];
    }
    return threads;
  }

  // --- Asking GitHub ----------------------------------------------------------------------------

  // Without a login GitHub answers 200 for a public repository and 404 for a private one. It
  // allows 60 requests an hour, so answers are kept for a day and a rate limit pauses checks.
  const checking = new Set();
  let pausedUntil = 0;

  // "answered", "limited", "failed", or "skipped" when a check is already running or paused.
  // Without an answer the repository keeps its last one, or stays blurred.
  async function check(repo) {
    if (checking.has(repo) || Date.now() < pausedUntil) return "skipped";
    checking.add(repo);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo.slice(GITHUB.length)}`, { headers: { Accept: "application/vnd.github+json" } });
      if (response.status === 200 || response.status === 404) {
        const visible = response.status === 200 && (await response.json()).private === false;
        state = { ...state, repos: { ...state.repos, [repo]: { public: visible, checkedAt: Date.now() } } };
        save();
        refresh();
        return "answered";
      }
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        pausedUntil = reset > Date.now() ? reset : Date.now() + RATE_LIMIT_PAUSE_MS;
        return "limited";
      }
      return "failed";
    } catch {
      return "failed";
    } finally {
      checking.delete(repo);
    }
  }

  // "Check GitHub again" asks about every repository, whatever the age of its answer, so one you
  // just made public shows up.
  let checkingAll = false;
  let lastCheck = null; // { at, total, answered, limited, failed }

  async function checkAll() {
    if (checkingAll) return;
    const repos = [...new Set([...knownRepos(), ...Object.keys(state.repos)])];
    checkingAll = true;
    pausedUntil = 0;
    repaint();
    const results = await Promise.all(repos.map(check));
    const count = (kind) => results.filter((result) => result === kind).length;
    lastCheck = { at: Date.now(), total: repos.length, answered: count("answered"), limited: count("limited"), failed: count("failed") };
    checkingAll = false;
    repaint();
  }

  // Only a profile that shows public repositories needs GitHub's answers.
  function checkStale() {
    if (!activeProfile()?.public) return;
    for (const repo of knownRepos()) {
      const known = state.repos[repo];
      if (!known || Date.now() - known.checkedAt > RECHECK_MS) check(repo);
    }
  }

  // --- Blurring ---------------------------------------------------------------------------------

  // The closest element whose whole text is a secret. Walking up covers a name split over
  // several nodes, as when sidebar search highlights the matched part.
  function evaluate(node) {
    if (!state.on || !secrets.size) return;
    for (let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node, i = 0; element && i < 4; element = element.parentElement, i++) {
      const text = element.textContent.trim();
      if (text.length > longest) return;
      if (secrets.has(text)) return element.setAttribute(MARK, "");
    }
  }

  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) return evaluate(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) if (node.data.trim()) evaluate(node);
  }

  // A blurred element whose text changed to something that is not a secret.
  function unmarkStale(node) {
    const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(`[${MARK}]`);
    if (element && !(state.on && secrets.has(element.textContent.trim()))) element.removeAttribute(MARK);
  }

  function rescan() {
    document.querySelectorAll(`[${MARK}]`).forEach((element) => element.removeAttribute(MARK));
    if (state.on) scan(document.body);
  }

  // --- Building UI ------------------------------------------------------------------------------

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...children.flat().filter((child) => child != null && child !== false));
    return node;
  };

  function lucide(name) {
    const icon = document.createElementNS(SVG_NS, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "t3sm-icon" })) icon.setAttribute(key, value);
    for (const [tag, attributes] of ICONS[name]) {
      const part = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
      icon.append(part);
    }
    return icon;
  }

  const clock = (time) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function checkStatus() {
    if (checkingAll) return "Checking GitHub…";
    if (!lastCheck) return "Asks which repositories are public now.";
    const { at, total, answered, limited, failed } = lastCheck;
    if (limited) return `GitHub's rate limit stopped ${limited} of ${total} checks. Try again after ${clock(pausedUntil)}.`;
    if (failed) return `${failed} of ${total} checks failed.`;
    return `Checked ${answered} repositories at ${clock(at)}.`;
  }

  // --- The eye button ---------------------------------------------------------------------------

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-t3sm-toggle", "");
  button.addEventListener("click", () => {
    closeMenu(false);
    setOn(!state.on);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (menu) closeMenu(true);
    else openMenu();
  });

  // After T3's filter button and its hidden input, before "Add project".
  function placeButton(trigger) {
    const anchor = trigger.nextElementSibling?.tagName === "INPUT" ? trigger.nextElementSibling : trigger;
    if (anchor.nextElementSibling !== button) anchor.after(button);
    if (button.className !== trigger.className) button.className = trigger.className;
    paintButton();
  }

  let painted = "";

  function paintButton() {
    const profile = config && config.profiles.length > 1 ? activeProfile() : null;
    const label = profile
      ? state.on ? `Streaming mode is on with ${profile.name}: show project names` : `Streaming mode: blur project names with ${profile.name}`
      : state.on ? "Streaming mode is on: show project names" : "Streaming mode: blur private project names";
    const title = `${label}\n${configurable ? "Right-click for profiles and GitHub checks." : "Right-click to check GitHub again."}`;
    const key = `${state.on}\n${checkingAll}\n${title}`;
    if (painted === key) return;
    painted = key;
    button.setAttribute("aria-pressed", String(state.on));
    button.setAttribute("aria-label", label);
    button.toggleAttribute("data-t3sm-checking", checkingAll);
    button.title = title;
    button.replaceChildren(lucide(state.on ? "eye-off" : "eye"));
  }

  // --- The eye's menu ---------------------------------------------------------------------------

  let menu = null;

  function openMenu() {
    menu = el("div", { className: "t3sm-menu dropdown-glass", role: "menu", "aria-label": "Streaming mode" });
    document.body.append(menu);
    renderMenu();
    const anchor = button.getBoundingClientRect();
    const below = anchor.bottom + 6;
    menu.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${below + menu.offsetHeight > innerHeight - 8 ? Math.max(8, anchor.top - 6 - menu.offsetHeight) : below}px`;
    button.setAttribute("aria-expanded", "true");
    (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector("[data-key]"))?.focus();
  }

  function closeMenu(returnFocus) {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.removeAttribute("aria-expanded");
    if (returnFocus && button.isConnected) button.focus();
  }

  function menuItem({ key, role = "menuitem", checked = false, label, detail, disabled = false, onClick }) {
    return el(
      "div",
      {
        className: "t3sm-item",
        role,
        tabindex: "-1",
        "data-key": key,
        "aria-checked": role === "menuitemradio" ? String(checked) : null,
        "aria-disabled": disabled ? "true" : null,
        onClick: disabled ? null : onClick,
        onMouseenter: (event) => event.currentTarget.focus(),
      },
      el("span", { className: "t3sm-item-check", "aria-hidden": "true" }, checked ? lucide("check") : null),
      el("span", { className: "t3sm-item-text" }, el("span", { className: "t3sm-item-label" }, label), detail ? el("span", { className: "t3sm-item-detail" }, detail) : null),
    );
  }

  function renderMenu() {
    if (!menu) return;
    const focused = menu.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const items = [];
    if (configurable && config) {
      items.push(el("div", { className: "t3sm-menu-label", role: "presentation" }, "Profile"));
      for (const profile of config.profiles) {
        items.push(menuItem({ key: `profile:${profile.id}`, role: "menuitemradio", checked: profile.id === config.active, label: profile.name, onClick: () => chooseProfile(profile.id) }));
      }
      items.push(el("div", { className: "t3sm-separator", role: "separator" }));
    }
    items.push(menuItem({ key: "check", label: "Check GitHub again", detail: checkStatus(), disabled: checkingAll, onClick: checkAll }));
    // The manager opens the settings panel. Without it, the item would do nothing.
    if (configurable && window.__t3extManager === true) items.push(menuItem({ key: "edit", label: "Edit profiles…", onClick: editProfiles }));
    menu.replaceChildren(...items);
    if (focused) menu.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  function chooseProfile(id) {
    closeMenu(true);
    updateConfig((current) => ({ ...current, active: id })).then(() => setOn(true));
  }

  function editProfiles() {
    closeMenu(true);
    dispatchEvent(new CustomEvent("t3ext:manage", { detail: { settings: ID } }));
  }

  function onMenuKey(event) {
    const items = [...menu.querySelectorAll("[data-key]")];
    const at = items.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (to !== undefined) {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[at]?.click();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
    }
  }

  // T3 handles keys on window in the capture phase and swallows some of them, so the menu takes
  // its keys there first, and T3's shortcuts stay out of it.
  addEventListener(
    "keydown",
    (event) => {
      if (!menu?.contains(event.target)) return;
      event.stopImmediatePropagation();
      onMenuKey(event);
    },
    true,
  );
  addEventListener(
    "pointerdown",
    (event) => {
      if (menu && !menu.contains(event.target) && !button.contains(event.target)) closeMenu(false);
    },
    true,
  );
  addEventListener("resize", () => closeMenu(false));

  // --- The settings panel -----------------------------------------------------------------------

  let panel = null; // { root, editing, query, painted } while the manager shows the panel

  function mountPanel(container) {
    const mounted = { root: el("div", { className: "t3sm-panel", "data-t3sm-panel": "" }), editing: config?.active ?? null, query: "", painted: "" };
    container.append(mounted.root);
    panel = mounted;
    renderPanel();
    return () => {
      commitName(mounted.root.querySelector("[data-profile]"));
      if (panel === mounted) panel = null;
    };
  }

  function renderPanel() {
    if (!panel || !config) return;
    const editing = config.profiles.find((profile) => profile.id === panel.editing) ?? activeProfile();
    panel.editing = editing.id;
    const painted = JSON.stringify([config, state.projects, state.repos, panel.editing, panel.query]);
    if (painted === panel.painted) return;
    panel.painted = painted;
    const focus = rememberFocus(panel.root);
    panel.root.replaceChildren(profilesSection(editing), editorSection(editing));
    restoreFocus(panel.root, focus);
  }

  // Re-rendering replaces every control, so the focused one, its text and its caret carry over.
  function rememberFocus(root) {
    const active = document.activeElement;
    if (!root.contains(active) || !active.dataset.focus) return null;
    const typed = active.tagName === "INPUT" && active.type === "text";
    return { key: active.dataset.focus, value: typed ? active.value : null, start: typed ? active.selectionStart : 0, end: typed ? active.selectionEnd : 0 };
  }

  function restoreFocus(root, focus) {
    if (!focus) return;
    // A "Use" button turns into the Active badge; focus goes to that profile then.
    const owner = focus.key.startsWith("use:") ? focus.key.slice("use:".length) : panel.editing;
    const target = root.querySelector(`[data-focus="${CSS.escape(focus.key)}"]`) ?? root.querySelector(`[data-focus="${CSS.escape(`profile:${owner}`)}"]`);
    if (!target) return;
    if (focus.value !== null && target.dataset.focus === focus.key) {
      target.value = focus.value;
      target.setSelectionRange(focus.start, focus.end);
    }
    target.focus();
  }

  function summaryOf(profile) {
    const count = profile.projects.length;
    const picked = `${count} picked project${count === 1 ? "" : "s"}`;
    if (profile.public) return count ? `Shows public repositories and ${picked}` : "Shows public GitHub repositories";
    return count ? `Shows only ${picked}` : "Blurs every project";
  }

  function profilesSection(editing) {
    return el(
      "section",
      { className: "t3sm-section", "aria-labelledby": "t3sm-profiles-heading" },
      el("h3", { className: "t3sm-heading", id: "t3sm-profiles-heading" }, "Profiles"),
      el(
        "ul",
        { className: "t3sm-profiles" },
        config.profiles.map((profile) =>
          el(
            "li",
            { className: "t3sm-profile", "data-editing": profile.id === editing.id },
            el(
              "button",
              {
                type: "button",
                className: "t3sm-profile-pick",
                "data-focus": `profile:${profile.id}`,
                "aria-current": profile.id === editing.id ? "true" : null,
                onClick: () => {
                  panel.editing = profile.id;
                  renderPanel();
                },
              },
              el("span", { className: "t3sm-profile-name" }, profile.name),
              el("span", { className: "t3sm-profile-summary" }, summaryOf(profile)),
            ),
            profile.id === config.active
              ? el("span", { className: "t3sm-badge" }, "Active")
              : el("button", { type: "button", className: "t3ext-button", "data-focus": `use:${profile.id}`, "aria-label": `Use ${profile.name}`, onClick: () => updateConfig((current) => ({ ...current, active: profile.id })) }, "Use"),
          ),
        ),
      ),
      el("button", { type: "button", className: "t3ext-button", "data-focus": "add", onClick: addProfile }, "Add profile"),
    );
  }

  function editorSection(profile) {
    const known = Object.entries(state.projects)
      .map(([key, project]) => ({ key, label: project.label, detail: project.detail }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const missing = profile.projects.filter((key) => !Object.hasOwn(state.projects, key)).map((key) => ({ key, label: key, detail: "Not in T3's project list now" }));
    const all = [...known, ...missing];
    const query = panel.query.trim().toLowerCase();
    const shown = query ? all.filter((project) => `${project.label}\n${project.detail}\n${project.key}`.toLowerCase().includes(query)) : all;
    const togglePublic = () => updateConfig((current) => withProfile(current, profile.id, (old) => ({ ...old, public: !old.public })));
    const toggleProject = (key) =>
      updateConfig((current) =>
        withProfile(current, profile.id, (old) => ({ ...old, projects: old.projects.includes(key) ? old.projects.filter((other) => other !== key) : [...old.projects, key] })),
      );
    return el(
      "section",
      { className: "t3sm-section", "aria-label": `Edit ${profile.name}` },
      el("h3", { className: "t3sm-heading" }, "Selected profile"),
      el(
        "div",
        { className: "t3sm-name-row" },
        el("input", {
          type: "text",
          className: "t3sm-input",
          value: profile.name,
          "aria-label": "Profile name",
          "data-focus": `name:${profile.id}`,
          "data-profile": profile.id,
          autocomplete: "off",
          spellcheck: "false",
          onChange: (event) => commitName(event.currentTarget),
          onKeydown: (event) => event.key === "Enter" && commitName(event.currentTarget),
        }),
        el(
          "button",
          { type: "button", className: "t3ext-button t3ext-button-danger", "data-focus": `delete:${profile.id}`, disabled: config.profiles.length < 2, title: config.profiles.length < 2 ? "The last profile cannot be deleted" : null, onClick: () => deleteProfile(profile) },
          "Delete",
        ),
      ),
      el(
        "div",
        { className: "t3sm-option" },
        el("button", { type: "button", role: "switch", className: "t3ext-switch", id: "t3sm-public", "aria-checked": String(profile.public), "data-focus": "public", onClick: togglePublic }, el("span", { className: "t3ext-switch-thumb" })),
        el("label", { className: "t3sm-option-label", for: "t3sm-public" }, "Also show public GitHub repositories"),
      ),
      el("h3", { className: "t3sm-heading" }, "Projects to show"),
      el(
        "p",
        { className: "t3sm-hint" },
        profile.public ? "Picked projects show along with public GitHub repositories. Every other name is blurred." : "Only picked projects show. Every other name is blurred, public repositories too.",
      ),
      all.length > FILTER_FROM
        ? el("input", {
            type: "text",
            className: "t3sm-input t3sm-filter",
            value: panel.query,
            placeholder: "Filter projects…",
            "aria-label": "Filter projects",
            "data-focus": "filter",
            autocomplete: "off",
            spellcheck: "false",
            onInput: (event) => {
              panel.query = event.currentTarget.value;
              renderPanel();
            },
          })
        : null,
      all.length
        ? el(
            "ul",
            { className: "t3sm-projects", "aria-label": "Projects to show" },
            shown.map((project) =>
              el(
                "li",
                {},
                el(
                  "label",
                  { className: "t3sm-project" },
                  el("input", { type: "checkbox", checked: profile.projects.includes(project.key), "data-focus": `project:${project.key}`, onChange: () => toggleProject(project.key) }),
                  el(
                    "span",
                    { className: "t3sm-project-text" },
                    el("span", { className: "t3sm-project-label" }, project.label),
                    project.detail ? el("span", { className: "t3sm-project-detail" }, project.detail) : null,
                  ),
                  isPublic(repoOf(project.key)) ? el("span", { className: "t3sm-tag" }, "Public") : null,
                ),
              ),
            ),
            shown.length ? null : el("li", { className: "t3sm-hint" }, "No matching projects"),
          )
        : el("p", { className: "t3sm-hint" }, "No projects yet. Streaming Mode learns them from T3's sidebar, so open the sidebar once and come back."),
    );
  }

  function commitName(input) {
    const profile = config?.profiles.find((candidate) => candidate.id === input?.dataset.profile);
    if (!profile) return;
    const name = input.value.trim();
    if (!name) input.value = profile.name;
    else if (name !== profile.name) updateConfig((current) => withProfile(current, profile.id, (old) => ({ ...old, name })));
  }

  function addProfile() {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const names = new Set(config.profiles.map((profile) => profile.name));
    let name = "New profile";
    for (let n = 2; names.has(name); n++) name = `New profile ${n}`;
    updateConfig((current) => ({ ...current, profiles: [...current.profiles, { id, name, public: false, projects: [] }] })).then(() => {
      if (!panel) return;
      panel.editing = id;
      renderPanel();
      const input = panel.root.querySelector(`[data-focus="${CSS.escape(`name:${id}`)}"]`);
      input?.focus();
      input?.select();
    });
  }

  function deleteProfile(profile) {
    if (config.profiles.length < 2 || !confirm(`Delete the profile "${profile.name}"?`)) return;
    updateConfig((current) => {
      const profiles = current.profiles.filter((other) => other.id !== profile.id);
      return { ...current, profiles, active: current.active === profile.id ? profiles[0].id : current.active };
    }).then(() => {
      if (!panel) return;
      panel.editing = config.active;
      renderPanel();
      panel.root.querySelector(`[data-focus="${CSS.escape(`profile:${config.active}`)}"]`)?.focus();
    });
  }

  // --- Keeping it applied -----------------------------------------------------------------------

  function repaint() {
    paintButton();
    renderMenu();
    renderPanel();
  }

  // Most GitHub answers change no secret, and a rescan walks the whole page.
  function refresh() {
    const before = secrets;
    setSecrets();
    if (before.size !== secrets.size || [...before].some((text) => !secrets.has(text))) rescan();
    repaint();
  }

  function applyConfig(value) {
    const next = parseConfig(value);
    if (JSON.stringify(next) === JSON.stringify(config)) return;
    config = next;
    refresh();
    checkStale();
  }

  const warned = new Set();
  function warnOnce(message) {
    if (!warned.has(message)) console.warn(LOG, message);
    warned.add(message);
  }

  // Projects that left T3's list are dropped, and so are their threads.
  function sync() {
    const trigger = document.querySelector(TRIGGER);
    if (!trigger) return;
    placeButton(trigger);
    const catalog = readCatalog(trigger);
    if (!catalog) return warnOnce("could not read T3's project list; blurring the names it last saw");
    const projects = projectsOf(catalog);
    const rows = readThreadRows();
    if (!rows) warnOnce("could not read T3's thread rows; blurring the thread titles it last saw");
    const threads = Object.fromEntries(Object.entries(rows ? threadsOf(rows) : state.threads).filter(([, thread]) => thread.project === null || Object.hasOwn(projects, thread.project)));
    if (JSON.stringify({ projects, threads }) !== JSON.stringify({ projects: state.projects, threads: state.threads })) {
      state = { ...state, projects, threads };
      save();
      refresh();
    }
    checkStale();
  }

  function setOn(on) {
    state = { ...state, on };
    save();
    repaint();
    rescan();
  }

  // Marks are set right after each change, before the next paint, so a name never flashes.
  // Changes in the chat area, the eye, its menu and the settings panel cannot change the project
  // list, so they skip reading it.
  const ownsNoProjects = (node) =>
    Boolean((node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-slot="sidebar-inset"], [data-t3sm-toggle], .t3sm-menu, [data-t3sm-panel]'));
  new MutationObserver((mutations) => {
    try {
      if (mutations.some((mutation) => !ownsNoProjects(mutation.target))) sync();
      for (const mutation of mutations) {
        unmarkStale(mutation.target);
        if (mutation.type === "characterData") evaluate(mutation.target);
        else mutation.addedNodes.forEach(scan);
      }
    } catch (error) {
      console.error(LOG, error);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Another T3 window turned streaming mode on or off, learned a repository's visibility, or saw
  // new projects and threads.
  addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    state = load();
    setSecrets();
    rescan();
    repaint();
  });

  if (configurable) {
    api.onConfigChange((id, value) => id === ID && applyConfig(value));
    api.getConfig(ID).then(applyConfig, (error) => {
      console.error(LOG, "could not read profiles; using the default", error);
      applyConfig(null);
    });
    (window.t3extSettings ??= new Map()).set(ID, mountPanel);
  }

  window.t3StreamingMode = {
    get on() {
      return state.on;
    },
    set on(on) {
      setOn(Boolean(on));
    },
    // The active profile's name. Set it to a profile's name or id; every window follows.
    get profile() {
      return activeProfile()?.name ?? null;
    },
    set profile(nameOrId) {
      const profile = config?.profiles.find((candidate) => candidate.id === nameOrId) ?? config?.profiles.find((candidate) => candidate.name === nameOrId);
      if (!profile) throw new Error(`${LOG} no profile named "${nameOrId}"`);
      if (configurable && profile.id !== config.active) updateConfig((current) => ({ ...current, active: profile.id }));
    },
    get profiles() {
      return structuredClone(config?.profiles ?? []);
    },
    get repos() {
      return structuredClone(state.repos);
    },
    get secrets() {
      return [...secrets];
    },
    // Same as "Check GitHub again" in the eye's menu. Resolves with { at, total, answered, limited, failed }.
    async refresh() {
      await checkAll();
      return lastCheck;
    },
  };

  sync();
  rescan();
}
