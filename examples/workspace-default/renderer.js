{
  const LOG = "[workspace-default]";
  const TRIGGER = '[data-composer-shortcut="composer.workspace"]';
  const OPEN_TRIGGER = `${TRIGGER}[aria-expanded="true"], ${TRIGGER}[data-popup-open]`;
  const ITEM = '[data-slot="select-item"]';
  const BUTTON = "t3wd-pin";
  const MODES = new Set(["local", "worktree"]);
  const PIN = [
    ["path", { d: "M12 17v5" }],
    ["path", { d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" }],
  ];

  const warned = new Set();
  function warnOnce(message, error) {
    if (!warned.has(message)) console.warn(LOG, message, error ?? "");
    warned.add(message);
  }

  // The project a composer's workspace menu belongs to: BranchToolbar's props.
  function projectOf(trigger) {
    let fiber = ext.t3.fiberOf(trigger);
    for (let i = 0; fiber && i < 60; fiber = fiber.return, i++) {
      const props = fiber.memoizedProps;
      if (typeof props?.projectId === "string" && typeof props?.environmentId === "string") {
        const key = `${props.environmentId}:${props.projectId}`;
        const name = ext.t3.projects()?.find((project) => project.refs.includes(key))?.name ?? null;
        return { key, environmentId: props.environmentId, projectId: props.projectId, name };
      }
    }
    return null;
  }

  // The mode a menu item picks: Base UI's SelectItem `value`.
  function modeOf(item) {
    let fiber = ext.t3.fiberOf(item);
    for (let i = 0; fiber && i < 8; fiber = fiber.return, i++) {
      const value = fiber.memoizedProps?.value;
      if (typeof value === "string") return MODES.has(value) ? value : null;
    }
    return null;
  }

  // Per project: { phase, pinned, inherited, error, retry, version }. phase is "loading" until the
  // first read, then "ready" or "saving". `pinned` is the project's own default, `inherited` its
  // environment's, each "local", "worktree" or null. `retry` is the default a failed save tried to
  // set, so a click tries it again. `version` counts saves, so a read that started before one is
  // dropped.
  const states = new Map();
  // Projects read since the menu opened, so each opening shows changes made elsewhere.
  const refreshed = new Set();

  function read(project, settings) {
    const entry = settings?.projectSettingsOverrides?.[project.projectId] ?? null;
    return {
      pinned: MODES.has(entry?.defaultThreadEnvMode) ? entry.defaultThreadEnvMode : null,
      inherited: MODES.has(settings?.defaultThreadEnvMode) ? settings.defaultThreadEnvMode : null,
      entry,
    };
  }

  // server.getSettings is light, but T3's own app no longer calls it; getConfig carries the same
  // settings with much more.
  async function fetchSettings(project) {
    const settings = await ext.t3.request(project.environmentId, "server.getSettings").catch((error) => {
      if (!error?.unknownTag) throw error;
      return ext.t3.request(project.environmentId, "server.getConfig").then((config) => config?.settings);
    });
    if (!settings?.projectSettingsOverrides) throw new Error("the server's settings have no projectSettingsOverrides");
    return settings;
  }

  function set(project, change) {
    states.set(project.key, { phase: "loading", pinned: null, inherited: null, error: null, retry: undefined, version: 0, ...states.get(project.key), ...change });
    schedule();
  }

  async function load(project) {
    set(project, {});
    const { version } = states.get(project.key);
    const current = () => states.get(project.key).version === version && states.get(project.key).phase !== "saving";
    try {
      const { pinned, inherited } = read(project, await fetchSettings(project));
      if (current()) set(project, { phase: "ready", pinned, inherited, error: null, retry: undefined });
    } catch (error) {
      warnOnce(`could not read the settings of ${project.key}`, error);
      if (current()) set(project, { phase: "ready", error: `Could not read this project's settings: ${error?.message ?? error}`, retry: undefined });
    }
  }

  // The override entry is replaced whole, so it is read fresh and only its workspace key changes.
  async function save(project, mode) {
    const before = states.get(project.key);
    set(project, { phase: "saving", pinned: mode, version: before.version + 1 });
    try {
      const { entry } = read(project, await fetchSettings(project));
      const next = { ...entry };
      if (mode) next.defaultThreadEnvMode = mode;
      else delete next.defaultThreadEnvMode;
      const saved = await ext.t3.request(project.environmentId, "server.updateSettings", {
        patch: { projectSettingsOverrides: { [project.projectId]: Object.keys(next).length ? next : null } },
      });
      const { pinned, inherited } = read(project, saved);
      set(project, { phase: "ready", pinned, inherited, error: null, retry: undefined });
    } catch (error) {
      console.warn(LOG, `could not save the default of ${project.key}`, error);
      set(project, { phase: "ready", pinned: before.pinned, error: `Could not save this project's default: ${error?.message ?? error}`, retry: mode });
    }
  }

  const LABELS = { local: "Current checkout", worktree: "New worktree" };

  function describe(project, mode, state) {
    const where = project.name ?? "this project";
    if (state.error) return `${state.error}. Click to try again.`;
    if (state.pinned === mode) return `${LABELS[mode]} is the default for new threads in ${where}. Click to stop pinning it.`;
    if (!state.pinned && state.inherited === mode) return `${LABELS[mode]} is the default for every project. Click to pin it for ${where}.`;
    return `Make ${LABELS[mode]} the default for new threads in ${where}`;
  }

  // Base UI picks an item on pointer and mouse events, so none of them may leave the button.
  function swallow(event) {
    event.stopPropagation();
    if (event.type !== "click") event.preventDefault();
  }

  function buttonFor(item) {
    let button = item.querySelector(`:scope > .${BUTTON}`);
    if (button) return button;
    button = ext.ui.el("button", { type: "button", className: BUTTON, tabindex: "-1" });
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) button.addEventListener(type, swallow);
    button.addEventListener("click", (event) => {
      swallow(event);
      const project = projectOf(document.querySelector(OPEN_TRIGGER));
      const mode = modeOf(item);
      const state = project && states.get(project.key);
      if (!project || !mode || state?.phase !== "ready") return;
      if (state.retry !== undefined) save(project, state.retry);
      else if (state.error) load(project);
      else save(project, state.pinned === mode ? null : mode);
    });
    item.append(button);
    return button;
  }

  function render(button, project, mode, state) {
    const kind = state.error ? "error" : state.pinned === mode ? "pinned" : !state.pinned && state.inherited === mode ? "inherited" : "unpinned";
    const signature = `${kind}|${state.phase}|${describe(project, mode, state)}`;
    if (button.dataset.signature === signature) return;
    button.dataset.signature = signature;
    button.dataset.kind = kind;
    button.toggleAttribute("disabled", state.phase === "saving");
    button.title = describe(project, mode, state);
    button.setAttribute("aria-label", button.title);
    button.replaceChildren(ext.ui.icon(PIN, "t3wd-size-icon"));
    if (kind === "pinned" || kind === "inherited") button.append(ext.ui.el("span", {}, "Default"));
  }

  function apply() {
    const trigger = document.querySelector(OPEN_TRIGGER);
    if (!trigger) {
      refreshed.clear();
      return;
    }
    const project = projectOf(trigger);
    if (!project) return warnOnce("could not find the project of the composer's workspace menu");
    if (!refreshed.has(project.key) && states.get(project.key)?.phase !== "saving") {
      refreshed.add(project.key);
      load(project);
    }
    const state = states.get(project.key);
    for (const item of document.querySelectorAll(ITEM)) {
      const mode = modeOf(item);
      if (!mode) continue;
      const button = buttonFor(item);
      button.hidden = state.phase === "loading";
      if (!button.hidden) render(button, project, mode, state);
    }
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

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "data-popup-open"],
  });

  window.t3WorkspaceDefault = {
    get states() {
      return Object.fromEntries([...states].map(([key, { phase, pinned, inherited, error }]) => [key, { phase, pinned, inherited, error }]));
    },
  };

  schedule();
}
