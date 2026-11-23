chrome.runtime.onInstalled.addListener(() => {
  // MV3 service worker stays stateless; WASM + embeddings run inside the offscreen document.
});
