import { systemClock } from "../../core/clock.js";

/**
 * Owns resources created during one UI lifetime. Cleanups run once, in reverse
 * registration order, so dependants are released before the resources they use.
 */
export function createCleanupScope() {
  const cleanups = new Set();
  let disposed = false;

  function addCleanup(cleanup) {
    if (typeof cleanup !== "function") throw new TypeError("Cleanup must be a function");
    let active = true;
    function run() {
      if (!active) return;
      active = false;
      cleanups.delete(run);
      cleanup();
    }
    if (disposed) run();
    else cleanups.add(run);
    return run;
  }

  function listen(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("Lifecycle listener target must be an EventTarget");
    }
    target.addEventListener(type, listener, options);
    return addCleanup(function () {
      target.removeEventListener(type, listener, options);
    });
  }

  function interval(callback, delay) {
    const id = setInterval(callback, delay);
    addCleanup(function () {
      clearInterval(id);
    });
    return id;
  }

  function timeout(callback, delay) {
    let cancel = null;
    const id = setTimeout(function () {
      if (cancel) cancel();
      callback();
    }, delay);
    cancel = addCleanup(function () {
      clearTimeout(id);
    });
    return id;
  }

  function raf(callback) {
    let cancel = null;
    const id = nextFrame(function (timestamp) {
      if (cancel) cancel();
      callback(timestamp);
    });
    cancel = addCleanup(function () {
      cancelFrame(id);
    });
    return id;
  }

  function observe(observer, target, options) {
    if (!observer || typeof observer.observe !== "function" || typeof observer.disconnect !== "function") {
      throw new TypeError("Lifecycle observer must support observe and disconnect");
    }
    observer.observe(target, options);
    return addCleanup(function () {
      observer.disconnect();
    });
  }

  function animate(target, keyframes, options) {
    if (!target || typeof target.animate !== "function")
      throw new TypeError("Lifecycle animation target must be animatable");
    const animation = target.animate(keyframes, options);
    addCleanup(function () {
      animation.cancel();
    });
    return animation;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const pending = Array.from(cleanups);
    cleanups.clear();
    const errors = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        pending[i]();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Lifecycle cleanup failed");
  }

  return {
    addCleanup: addCleanup,
    listen: listen,
    interval: interval,
    timeout: timeout,
    raf: raf,
    observe: observe,
    animate: animate,
    dispose: dispose,
    get disposed() {
      return disposed;
    },
  };
}

export function createModuleLifecycle(options) {
  const defaults = options.defaults;
  let hooks = defaults();
  let scope = null;

  function register(nextHooks) {
    Object.assign(hooks, nextHooks || {});
  }

  function beginInit() {
    dispose(false);
    scope = createCleanupScope();
    return scope;
  }

  function dispose(resetHooks) {
    const activeScope = scope;
    scope = null;
    if (activeScope) activeScope.dispose();
    if (resetHooks !== false) hooks = defaults();
  }

  return {
    get hooks() {
      return hooks;
    },
    get scope() {
      return scope;
    },
    register: register,
    beginInit: beginInit,
    dispose: dispose,
  };
}

/** @param {(timestamp: number) => void} callback */
export function nextFrame(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(function () {
    callback(typeof performance === "object" ? performance.now() : systemClock.now());
  }, 16);
}

/** @param {number | ReturnType<typeof setTimeout>} handle */
export function cancelFrame(handle) {
  if (
    typeof handle === "number" &&
    typeof cancelAnimationFrame === "function" &&
    typeof requestAnimationFrame === "function"
  ) {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}
