# Streaming Mode

When you stream or share your screen, you may not want viewers to read the names of your private projects or what you work on in them. This extension adds an eye button next to the sidebar's project filter. While it is on, project names are blurred, and so are the titles and branch names of their threads. The active profile decides which projects stay readable. The default profile keeps public GitHub repositories readable and blurs everything else.

![The project filter with streaming mode on](preview.png)

## What it does

Click the eye after the filter icon. It turns into a crossed-out eye in T3's accent color, and these are blurred for every project the active profile does not show, wherever one of them is the whole text of an element, such as the sidebar rows, the project name in the header breadcrumb and the Project Groups menu:

- the project's name in the sidebar,
- its folder name and its path,
- its repository as `owner/name` and as `github.com/owner/name`,
- the title of each of its threads, in the sidebar and in the chat header,
- the branch name under each of its threads.

Click the eye again to show every name.

Right-click the eye, or focus it and press the context menu key, to open its menu:

- **Profile** lists your profiles. Choose one to make it active. Choosing one also turns streaming mode on.
- **Check GitHub again** asks GitHub about every repository, for example after you make one public. The eye pulses while it checks, and the line under the item then says when it last checked, or that GitHub's rate limit stopped some checks and when you can try again.
- **Edit profiles…** opens the profile settings in the extension manager.

Arrow keys move through the menu, Enter chooses, and Escape closes it.

On/off is saved in the window's `localStorage` under `t3ext.streaming-mode`, so it survives a reload, and other open T3 windows follow it through the `storage` event. Profiles are saved by the extension host, so every window uses the same ones.

## Profiles

A profile says which projects stay readable. It has two parts:

- **Picked projects.** Each project you pick stays readable. Picking a repository covers every clone and worktree of it.
- **Also show public GitHub repositories.** When this is on, every repository GitHub says is public stays readable too.

Everything else is blurred. For example:

| Profile | Public repositories | Picked | Readable |
| --- | --- | --- | --- |
| Public repositories (the default) | on | none | public repositories only |
| Work only | off | your work repositories | only the work repositories, even public ones are blurred |
| Whitelist | on | a few private repositories | public repositories and those private ones |

To edit profiles, open **Extensions > Manage Extensions…** and click **Settings** on the Streaming Mode row, or choose **Edit profiles…** in the eye's menu. There you can add, rename and delete profiles, make one active with **Use**, turn on **Also show public GitHub repositories**, and pick projects from a checklist. A filter appears above the checklist when it is long. Every change applies at once, in every window.

The checklist shows the projects T3's sidebar has listed. A project you picked that T3 no longer lists still shows, under its key, so you can uncheck it. While streaming mode is on, the names of blurred projects are blurred in the checklist too. Point at a row, or move focus to it, to read its name.

The last profile cannot be deleted. Deleting the active profile makes the first one active.

## How it knows

**Projects come from T3's sidebar.** The extension reads the sidebar's memoized project list from the React fiber of T3's filter button (`aria-label` starting with "Filter threads by project"). Each project there carries T3's `repositoryIdentity`, which T3 takes from the `origin` remote, with the GitHub owner and name. A project's key is that `canonicalKey`, such as `github.com/owner/name`, in lower case. A project without a remote uses its folder path as its key.

**Threads come from T3's sidebar rows.** Each thread row (`data-thread-item`) is rendered from props that hold the thread, with its title and branch, and its project. A thread's title and branch are blurred when its project is blurred. A thread outside any project is always blurred.

**Everything seen is kept.** The extension keeps every project and thread it has seen, with the texts it would blur, whether the active profile shows them or not. So a profile switch applies at once: the open thread's title in the chat header, and the breadcrumb while the sidebar is collapsed, follow the new profile. Projects that leave T3's list are dropped, with their threads.

**GitHub says what is public.** For each `github.com` repository the extension calls `https://api.github.com/repos/<owner>/<name>` without logging in. GitHub answers 200 with `"private": false` for a public repository, and 404 for a private one, so a private repository you can read yourself still counts as private. The answer is kept for a day, then checked again. Only a profile with **Also show public GitHub repositories** on asks GitHub.

**Anything not known to be public is blurred** in a profile that shows public repositories. This covers a project with no remote, a remote that is not on github.com, a repository GitHub has not answered for yet, and a check that failed offline or hit the rate limit. GitHub allows 60 calls an hour without a login. When it answers with a rate limit, checks pause until the time GitHub gives.

**Names never flash.** A `MutationObserver` marks each new or changed text before the next paint. A name split over several nodes, as when sidebar search highlights the matched part, is matched on the element that holds all of it. Until the host has sent the profiles after a reload, every known name is blurred.

## Known limits

- Only text that is exactly a project name, path or repository, or a thread title or branch, is blurred. A name inside a longer text is not: a chat message, a command or a file path in a tool call.
- A thread is known only after its row has been in the sidebar once. A thread you open from somewhere else, such as a link, shows its title until its row appears.
- Text that happens to equal a blurred thread title is blurred too, for example the title of a thread in a readable project that has the same title.
- Project icons stay visible, including T3's two-letter monograms.
- Native `title` tooltips and hover tooltips are not blurred, such as Project Groups' "Filter threads by project: Acme" and a worktree icon's "Worktree: name (branch)".
- A repository you make private shows its name until its answer is checked again, after a day or when you choose **Check GitHub again**.
- **Check GitHub again** costs one of GitHub's 60 calls an hour per repository. With about 40 repositories, a second check within the hour runs into the limit, and the repositories it could not check keep their previous answer.
- Profiles need a host that keeps extension config. After you update this checkout, T3 Code loads the new `renderer.js` on the next window reload, but the host updates only when T3 Code restarts through T3 Code+. Until then the extension uses the default profile, and its menu only checks GitHub.
- If a T3 update renames what the extension reads, it keeps blurring the names it last saw, misses new projects, and logs one warning with `[streaming-mode]` in the console.

## Controls

In the window's DevTools console:

```js
t3StreamingMode.on;                    // true while names are blurred
t3StreamingMode.on = true;             // same as clicking the eye
t3StreamingMode.profile;               // the active profile's name
t3StreamingMode.profile = "Work only"; // make a profile active, by name or id, in every window
t3StreamingMode.profiles;              // [{ id, name, public, projects }]
t3StreamingMode.repos;                 // { "github.com/owner/name": { public, checkedAt } }
t3StreamingMode.secrets;               // every text that is blurred, project names and thread titles
await t3StreamingMode.refresh();       // same as Check GitHub again: { at, total, answered, limited, failed }
```
