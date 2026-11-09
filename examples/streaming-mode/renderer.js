{
  const STORAGE_KEY = "t3ext.streaming-mode";
  const LOG = "[streaming-mode]";
  const MARK = "data-t3sm-blur";
  const GITHUB = "github.com/";
  const RECHECK_MS = 24 * 60 * 60 * 1000;
  const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
  const FILTER_FROM = 8;
  // T3's label for threads outside any project. It names nothing.
  const PLACEHOLDER = "No project";

  const { el } = ext.ui;

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
  let config = null;
  const activeProfile = () => config?.profiles.find((profile) => profile.id === config.active) ?? null;
  const withProfile = (current, id, change) => ({ ...current, profiles: current.profiles.map((profile) => (profile.id === id ? change(profile) : profile)) });

  // Every window, this one too, applies the saved result through ext.config.subscribe.
  const updateConfig = (change) =>
    ext.config.update((saved) => change(parseConfig(saved))).catch((error) => console.error(LOG, "could not save profiles", error));

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

  // Every clone and worktree of one repository shares its key, so picking it covers them all.
  const projectKey = (member) => member?.repository?.key?.toLowerCase() || member?.workspaceRoot || null;

  const textsOf = (...values) =>
    [...new Set(values.filter((text) => typeof text === "string").map((text) => text.trim()).filter((text) => text && text !== PLACEHOLDER))].sort();

  // Every text T3 shows for each project: the sidebar name, the folder name, its path, its
  // repository's name, and the name of its sidebar group.
  function projectsOf(groups) {
    const projects = {};
    for (const group of groups) {
      for (const member of group.members) {
        const key = projectKey(member);
        if (!key) continue;
        const repository = member.repository;
        const known = projects[key] ?? { label: textsOf(repository?.name)[0] ?? textsOf(member.title)[0] ?? key, detail: member.workspaceRoot ?? "", texts: [] };
        known.texts = textsOf(...known.texts, member.title, member.workspaceRoot, repository?.name, repository?.key, group.name);
        projects[key] = known;
      }
    }
    return projects;
  }

  // The thread and project each sidebar row renders from, null when T3 renamed what this reads.
  function readThreadRows() {
    const rows = ext.t3.threadRows();
    const read = rows.map((row) => ext.t3.rowData(row.element)).filter((data) => data && "project" in data);
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

  const lucide = (name) => ext.ui.icon(ICONS[name], "t3sm-icon");

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
    const title = `${label}\nRight-click for profiles and GitHub checks.`;
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

  let menu = null; // the open layer

  // Below the eye, or above it when there is no room below.
  function placeMenu(element) {
    const anchor = button.getBoundingClientRect();
    const below = anchor.bottom + 6;
    element.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${below + element.offsetHeight > innerHeight - 8 ? Math.max(8, anchor.top - 6 - element.offsetHeight) : below}px`;
  }

  function openMenu() {
    const element = el("div", { className: "t3sm-menu dropdown-glass", role: "menu", "aria-label": "Streaming mode" });
    renderMenu(element);
    menu = ext.ui.layer(element, { anchor: button, place: placeMenu, onKey: onMenuKey, onClose: () => (menu = null) });
    (element.querySelector('[aria-checked="true"]') ?? element.querySelector("[data-key]"))?.focus();
  }

  const closeMenu = (returnFocus) => menu?.close(returnFocus);

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

  function renderMenu(element = menu?.element) {
    if (!element) return;
    const focused = element.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const items = [];
    if (config) {
      items.push(el("div", { className: "t3sm-menu-label", role: "presentation" }, "Profile"));
      for (const profile of config.profiles) {
        items.push(menuItem({ key: `profile:${profile.id}`, role: "menuitemradio", checked: profile.id === config.active, label: profile.name, onClick: () => chooseProfile(profile.id) }));
      }
      items.push(el("div", { className: "t3sm-separator", role: "separator" }));
    }
    items.push(menuItem({ key: "check", label: "Check GitHub again", detail: checkStatus(), disabled: checkingAll, onClick: checkAll }));
    // The manager opens the settings panel. Without it, the item would do nothing.
    if (ext.settings.canOpen()) items.push(menuItem({ key: "edit", label: "Edit profiles…", onClick: editProfiles }));
    element.replaceChildren(...items);
    if (focused) element.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  function chooseProfile(id) {
    closeMenu(true);
    updateConfig((current) => ({ ...current, active: id })).then(() => setOn(true));
  }

  function editProfiles() {
    closeMenu(true);
    ext.settings.open();
  }

  function onMenuKey(event) {
    const items = [...menu.element.querySelectorAll("[data-key]")];
    const at = items.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (to !== undefined) {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[at]?.click();
    } else if (event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
    }
  }

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
    const trigger = ext.t3.filterButton();
    if (!trigger) return;
    placeButton(trigger);
    const groups = ext.t3.projects();
    if (!groups) return warnOnce("could not read T3's project list; blurring the names it last saw");
    const projects = projectsOf(groups);
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

  ext.config.subscribe(applyConfig);
  ext.settings.register(mountPanel);

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
      if (profile.id !== config.active) updateConfig((current) => ({ ...current, active: profile.id }));
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
