// The game runs in a frame from another origin, so the T3 window cannot reach into it. The main
// process can: this adds a small listener to every Doom frame that pauses the game when the T3
// window asks, the way Esc does.
const GAME_ORIGIN = "https://doom.spipu.net";

// Runs inside the game's page. doom-js pauses when it loses the mouse grab (Esc while the mouse
// is grabbed), or on an Esc key press otherwise. An open menu (`.app-menu-display`) means the
// game is already paused or not started, where Esc would step back instead.
// Its pause menu only freezes the game's sound effects and keeps the music going, so the whole
// sound is stopped too, through the one AudioContext all of its sound goes through
// (`doomSound._engine`, a global of the page), and started again when the game is shown.
const BRIDGE = `(() => {
  if (window.__t3doomBridge) return;
  window.__t3doomBridge = true;
  const press = (type) => document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true }));
  const sound = () => (typeof doomSound === "undefined" ? null : doomSound._engine);
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data === "t3doom:play") sound()?.resumeAll();
    if (event.data !== "t3doom:pause") return;
    sound()?.suspendAll();
    if (document.pointerLockElement) document.exitPointerLock();
    else if (document.querySelector("canvas") && !document.querySelector(".app-menu-display")) {
      press("keydown");
      setTimeout(() => press("keyup"), 150);
    }
  });
  parent.postMessage("t3doom:ready", "*");
})()`;

module.exports = ({ electron }) => {
  const { app, webContents, webFrameMain } = electron;
  const inject = (frame) => {
    if (frame?.origin === GAME_ORIGIN) frame.executeJavaScript(BRIDGE).catch(() => {});
  };
  const watch = (contents) => {
    contents.on("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
      if (!isMainFrame) inject(webFrameMain.fromId(processId, routingId));
    });
    // Attached late: a game frame may already be open.
    try {
      contents.mainFrame.framesInSubtree.forEach(inject);
    } catch {}
  };
  app.on("web-contents-created", (_event, contents) => watch(contents));
  webContents.getAllWebContents().forEach(watch);
};
