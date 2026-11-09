ext.settings.register((container) => {
  const text = document.createElement("p");
  text.className = "sample-panel";
  text.textContent = "Sample settings";
  container.append(text);
});
window.__t3extSample = { loadedAt: Date.now(), id: extensionId, ext };
