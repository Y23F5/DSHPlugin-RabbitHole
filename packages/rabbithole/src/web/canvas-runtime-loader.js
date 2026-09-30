let runtimePromise = null;
let loadedRuntime = null;
let warmScheduled = false;

function versionedAssetUrl(name) {
  const url = new URL(name, document.baseURI);
  const app = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[type="module"][src*="app.js"]'));
  if (app?.src) {
    const version = new URL(app.src, document.baseURI).searchParams.get("v");
    if (version) url.searchParams.set("v", version);
  }
  return url.href;
}

function loadDompurify() {
  if (window.DOMPurify?.sanitize) return Promise.resolve();
  let existing = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[data-rabbithole-canvas-runtime="dompurify"]'));
  if (existing && existing.dataset.rabbitholeCanvasRuntimeState !== "loading") {
    existing.remove();
    existing = null;
  }
  return new Promise((resolve, reject) => {
    const script = existing || document.createElement("script");
    const fail = (message) => {
      script.dataset.rabbitholeCanvasRuntimeState = "error";
      script.remove();
      reject(new Error(message));
    };
    const finish = () => {
      if (!window.DOMPurify?.sanitize) {
        fail("DOMPurify did not initialize");
        return;
      }
      script.dataset.rabbitholeCanvasRuntimeState = "loaded";
      resolve();
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => fail("Unable to load DOMPurify"), { once: true });
    if (!existing) {
      script.dataset.rabbitholeCanvasRuntime = "dompurify";
      script.dataset.rabbitholeCanvasRuntimeState = "loading";
      script.src = versionedAssetUrl("dompurify.js");
      document.head.appendChild(script);
    }
  });
}

function loadKatexStyles() {
  let existing = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[data-rabbithole-canvas-runtime="katex"]'));
  if (existing?.sheet) return Promise.resolve();
  if (existing && existing.dataset.rabbitholeCanvasRuntimeState !== "loading") {
    existing.remove();
    existing = null;
  }
  return new Promise((resolve, reject) => {
    const link = existing || document.createElement("link");
    link.addEventListener("load", () => {
      link.dataset.rabbitholeCanvasRuntimeState = "loaded";
      resolve();
    }, { once: true });
    link.addEventListener("error", () => {
      link.dataset.rabbitholeCanvasRuntimeState = "error";
      link.remove();
      reject(new Error("Unable to load the math stylesheet"));
    }, { once: true });
    if (!existing) {
      link.dataset.rabbitholeCanvasRuntime = "katex";
      link.dataset.rabbitholeCanvasRuntimeState = "loading";
      link.rel = "stylesheet";
      link.href = versionedAssetUrl("katex.css");
      document.head.appendChild(link);
    }
  });
}

export function loadCanvasRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("./canvas-runtime.js"),
      loadDompurify(),
      loadKatexStyles(),
    ]).then(([runtime]) => {
      loadedRuntime = runtime;
      return runtime;
    }).catch((error) => {
      runtimePromise = null;
      loadedRuntime = null;
      throw error;
    });
  }
  return runtimePromise;
}

export function currentCanvasRuntime() {
  return loadedRuntime;
}

export function warmCanvasRuntime() {
  if (loadedRuntime || runtimePromise || warmScheduled) return;
  warmScheduled = true;
  const warm = () => {
    warmScheduled = false;
    void loadCanvasRuntime().catch(() => {});
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 1500 });
  else setTimeout(warm, 0);
}
