# t3-ext

Adds extensions to the installed T3 Code without forking it. `README.md` covers installing, writing and testing extensions; `docs/internals.md` covers how loading works.

- Test with `npm test` and `npm run e2e`, which runs against a temporary copy of T3 Code. Never attach a debugger or CDP to the T3 Code Julio is running: on 27 Oct a probe raised main-process error dialogs that blocked it for minutes.
- When a change is ready, tell Julio how it reaches his running app. A `style.css` or `renderer.js` change needs **Extensions > Reload Window**. A `main.js` or host change needs T3 Code quit (⌘Q) and opened again through T3 Code+.
