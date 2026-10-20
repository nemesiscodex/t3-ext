# Project Groups

T3's sidebar filter picks one project or all of them. This extension lets you pick several, and save a selection as a named group with an icon, such as "Acme" with a rocket for three client repositories. The sidebar then shows only the threads of those projects.

![The project filter with three groups](preview.png)

## What it does

The filter button next to the sidebar search opens a menu with:

- **Search projects…** to narrow the list. Typing on any row also types here.
- **All projects** to clear the filter.
- **Groups**: each group with its icon, its number of projects and an edit button. Click a group to filter by it. **New group…** opens the group editor.
- **Projects**: every project with a checkbox. Checking projects filters by all of them at once. If a group is active, checking or unchecking a project starts a new selection from that group's projects.
- **Save as group…** when two or more projects are checked.

The group editor asks for a name, an icon and the projects. The icons and emoji are the same ones T3 offers for a project icon. **Delete** removes an existing group; click it twice to confirm. Deleting the active group shows all projects again.

The button shows the active filter: T3's filter icon for all projects, the group's icon for a group, the project's icon for one project, and a small count for several projects. Its tooltip names the filter, such as "Filter threads by project: Acme".

Keyboard: Enter, Space or Down on the button opens the menu. Up and Down move between rows, Enter or Space picks a row, Right moves to a group's edit button, and Escape closes the menu. In the editor, Enter in the name saves and Escape cancels.

The groups and the filter are saved in the window's `localStorage` under `t3ext.project-groups`, so they survive a reload. Other open T3 windows pick up a change through the `storage` event.

## How it knows

**Projects come from T3's sidebar.** The extension reads two things from the React fiber of T3's filter button (`aria-label` starting with "Filter threads by project"): the button's own props (`items`, `value`, `onValueChange`), and the sidebar's memoized project list (`projectGroups`, with each project's `memberProjectRefs`). A project is saved as `<environmentId>:<projectId>`, so groups keep working if you change T3's project grouping setting.

**One project uses T3's own filter.** When the selection is exactly one of T3's projects, the extension sets T3's filter to it, as if you had picked it in T3's menu. Everything then behaves as in T3, including **New thread** in that project.

**Several projects hide rows.** T3's filter can hold only one project, so for several the extension sets T3's filter to all projects and hides the rows of other projects with CSS. It finds each row's project in the row's React props: threads, drafts and search results. It also hides the pinned and draft dividers when nothing is left under them, and shows "No threads in Acme" when no row is left. A `MutationObserver` hides new rows as React renders them, before they are painted.

**T3's own "Filter by" wins.** When T3 changes its filter itself, as the thread menu's **Filter by <project>** does, the extension follows: the filter becomes that project. This was checked by setting T3's filter directly, because a script cannot open T3's native thread menu.

**It fails open.** If a T3 update renames what the extension reads, it leaves T3's filter button and every row as they are, and logs one warning with `[project-groups]` in the console.

## Known limits

These apply when several projects are selected, so T3's own filter is set to all projects:

- **Settled (N)** counts the settled threads of every project.
- The ⌘1–⌘9 jump labels number hidden threads too, and ⌘⇧[ and ⌘⇧] move through hidden threads.
- **New thread** asks for a project from all of them, not only the group's.
- In sidebar search, the result selected for Enter can be a hidden one.

Always:

- The project settings button that T3's own menu shows next to each project is not in this menu.

## Controls

In the window's DevTools console:

```js
t3ProjectGroups.state;                        // { version, groups, filter }
t3ProjectGroups.groups;                       // [{ id, name, icon, projects }]
t3ProjectGroups.catalog();                    // T3's projects: { key, name, icon, refs }
t3ProjectGroups.setFilter({ kind: "all" });
t3ProjectGroups.setFilter({ kind: "group", id: t3ProjectGroups.groups[0].id });
t3ProjectGroups.setFilter({ kind: "projects", projects: t3ProjectGroups.catalog()[0].refs });
t3ProjectGroups.resolve();                    // what the filter does now: mode "all", "native" or "hide"
t3ProjectGroups.open();                       // opens the menu
```

## Icons

The lucide icon data in `renderer.js` is generated from T3's own bundle, so the picker matches T3's. After a T3 update, regenerate it from this folder:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)" scripts/icons.cjs
```

T3's binary runs the script as Node, because plain Node cannot read inside `app.asar`. With a folder of T3's client assets already extracted, `node scripts/icons.cjs <folder>` works too.

The icons are from [Lucide](https://lucide.dev), ISC license, Copyright (c) Lucide Contributors.
