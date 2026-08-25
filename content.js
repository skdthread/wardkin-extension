(() => {
if (globalThis.__wardkinApplyState) {
  try {
    globalThis.__wardkinApplyState();
  } catch {
    // Previous instance is gone (extension reload or page navigation).
  }
  return;
}

const STORAGE_KEY = "blockedHosts";
const SESSION_KEY = "concentrationSession";
const PENDING_KEY = "pendingCelebration";
const DISMISS_KEY = "wardkinSessionDismissed";
const OVERLAY_HOST_ATTR = "data-wardkin-overlay";
const WARN_HOST_ATTR = "data-wardkin-warning";

let listenersDetached = false;

function isContextInvalidatedError(reason) {
  const text = String(reason?.message ?? reason ?? "");
  return text.includes("Extension context invalidated");
}

// Last-resort net: if any promise from this script still rejects with a
// context-invalidated error (e.g. the extension is reloaded mid-request),
// keep it out of the console and shut this instance down.
window.addEventListener("unhandledrejection", (event) => {
  if (isContextInvalidatedError(event.reason)) {
    event.preventDefault();
    detachListeners();
  }
});

window.addEventListener("error", (event) => {
  if (isContextInvalidatedError(event.error ?? event.message)) {
    event.preventDefault();
    detachListeners();
  }
});

let warningTimer = null;
let warningExpiryTimer = null;
let sessionExpiryTimer = null;
let shownSessionStartedAt = null;
let expiryNotifiedStartedAt = null;

function isExtensionAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function swallowLastError() {
  try {
    void chrome.runtime.lastError;
  } catch {
    // Extension context invalidated.
  }
}

function getLocal(keys) {
  return new Promise((resolve) => {
    if (listenersDetached || !isExtensionAlive()) {
      resolve(null);
      return;
    }
    try {
      const pending = chrome.storage.local.get(keys, (result) => {
        swallowLastError();
        resolve(result ?? null);
      });
      // MV3 may still return a Promise; ignore its rejection so Chrome
      // does not report "Uncaught (in promise) Extension context invalidated".
      pending?.catch?.(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function sendRuntimeMessage(message) {
  if (listenersDetached || !isExtensionAlive()) return;
  try {
    const pending = chrome.runtime.sendMessage(message, () => {
      swallowLastError();
    });
    pending?.catch?.(() => {});
  } catch {
    // Extension context invalidated.
  }
}

function refreshState() {
  applyState().catch(() => {});
}

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  refreshState();
}

function onPageShow() {
  refreshState();
}

function onPageHide(event) {
  if (event.persisted) return;
  detachListeners();
}

function onStorageChanged(changes, areaName) {
  if (listenersDetached || areaName !== "local") return;
  if (changes[STORAGE_KEY] || changes[SESSION_KEY]) {
    refreshState();
    return;
  }
  if (changes[PENDING_KEY]) {
    maybeShowPendingCelebration(changes[PENDING_KEY].newValue || null);
  }
}

function reply(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    detachListeners();
  }
}

function onRuntimeMessage(message, _sender, sendResponse) {
  try {
    if (listenersDetached || !isExtensionAlive()) {
      detachListeners();
      return;
    }
    if (message?.type === "applyState") {
      Promise.resolve(applyState())
        .then(() => reply(sendResponse, { ok: true }))
        .catch(() => {
          reply(sendResponse, { ok: false });
          detachListeners();
        });
      return true;
    }
    if (message?.type === "sessionComplete") {
      const visible = document.visibilityState === "visible";
      if (visible) {
        showCelebrate(message);
      }
      reply(sendResponse, {
        shown:
          visible && Boolean(document.getElementById("wardkin-celebrate-root")),
      });
    }
  } catch {
    detachListeners();
  }
}

function detachListeners() {
  if (listenersDetached) return;
  listenersDetached = true;

  stopWarningTimers();
  if (sessionExpiryTimer) {
    clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = null;
  }

  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pageshow", onPageShow);
  window.removeEventListener("pagehide", onPageHide);
  try {
    chrome.storage?.onChanged?.removeListener(onStorageChanged);
  } catch {
    // Extension context invalidated.
  }
  try {
    chrome.runtime?.onMessage?.removeListener(onRuntimeMessage);
  } catch {
    // Extension context invalidated.
  }
}

function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function currentHost() {
  return normalizeHost(window.location.hostname);
}

function isHostBlocked(hosts) {
  const host = currentHost();
  return hosts.some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`)
  );
}

function isSessionHost(session) {
  const host = currentHost();
  return host === session.host || host.endsWith(`.${session.host}`);
}

function isSessionActive(session) {
  return Boolean(session?.host && session.endsAt > Date.now());
}

function wasWarningDismissed(session) {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === String(session.startedAt);
  } catch {
    return false;
  }
}

function dismissWarning(session) {
  try {
    sessionStorage.setItem(DISMISS_KEY, String(session.startedAt));
  } catch {
    // Ignore quota or disabled storage.
  }
  hideWarning();
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

function applyPageLockStyles() {
  const html = document.documentElement;
  const body = document.body;

  html.dataset.wardkinOverflow = html.style.overflow || "";
  html.style.overflow = "hidden";
  html.style.overscrollBehavior = "none";

  if (!body) return;

  if (body.dataset.wardkinOverflow === undefined) {
    body.dataset.wardkinOverflow = body.style.overflow || "";
  }
  if (body.dataset.wardkinFilter === undefined) {
    body.dataset.wardkinFilter = body.style.filter || "";
  }

  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "none";
  // Greyscale the page only — overlay lives under <html>, so it stays in color.
  body.style.filter = "grayscale(100%)";
}

function clearPageLockStyles() {
  const html = document.documentElement;
  const body = document.body;

  if (html.dataset.wardkinOverflow !== undefined) {
    html.style.overflow = html.dataset.wardkinOverflow;
    delete html.dataset.wardkinOverflow;
  }
  html.style.overscrollBehavior = "";

  if (!body) return;

  if (body.dataset.wardkinOverflow !== undefined) {
    body.style.overflow = body.dataset.wardkinOverflow;
    delete body.dataset.wardkinOverflow;
  }
  if (body.dataset.wardkinFilter !== undefined) {
    body.style.filter = body.dataset.wardkinFilter;
    delete body.dataset.wardkinFilter;
  }
  body.style.overscrollBehavior = "";
}

function preventScrollEvent(event) {
  event.preventDefault();
}

function attachScrollGuards() {
  window.addEventListener("wheel", preventScrollEvent, { passive: false });
  window.addEventListener("touchmove", preventScrollEvent, { passive: false });
  window.addEventListener("keydown", preventScrollKeys, true);
}

function detachScrollGuards() {
  window.removeEventListener("wheel", preventScrollEvent);
  window.removeEventListener("touchmove", preventScrollEvent);
  window.removeEventListener("keydown", preventScrollKeys, true);
}

function preventScrollKeys(event) {
  const keys = [
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
  ];
  if (keys.includes(event.key)) {
    event.preventDefault();
  }
}

function showOverlay() {
  if (document.documentElement.hasAttribute(OVERLAY_HOST_ATTR)) {
    applyPageLockStyles();
    return;
  }

  document.documentElement.setAttribute(OVERLAY_HOST_ATTR, "true");
  applyPageLockStyles();
  attachScrollGuards();

  const mount = () => {
    applyPageLockStyles();
    if (document.getElementById("wardkin-block-root")) return;

    const root = document.createElement("div");
    root.id = "wardkin-block-root";
    root.style.all = "initial";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483647";

    const shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host, .overlay {
          all: initial;
        }
        .overlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          background: rgba(156, 163, 175, 0.88);
          font-family: "Segoe UI", system-ui, sans-serif;
          pointer-events: auto;
          touch-action: none;
          user-select: none;
        }
        p {
          margin: 0;
          padding: 24px;
          color: #dc2626;
          font-size: clamp(1.75rem, 4vw, 2.5rem);
          font-weight: 700;
          letter-spacing: 0.01em;
          text-align: center;
        }
      </style>
      <div class="overlay" part="overlay">
        <p>This site is blocked</p>
      </div>
    `;

    document.documentElement.appendChild(root);
  };

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
}

function hideOverlay() {
  document.documentElement.removeAttribute(OVERLAY_HOST_ATTR);
  document.getElementById("wardkin-block-root")?.remove();
  clearPageLockStyles();
  detachScrollGuards();
}

function stopWarningTimers() {
  if (warningTimer) {
    clearInterval(warningTimer);
    warningTimer = null;
  }
  if (warningExpiryTimer) {
    clearTimeout(warningExpiryTimer);
    warningExpiryTimer = null;
  }
}

function armSessionExpiry(session) {
  if (sessionExpiryTimer) {
    clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = null;
  }
  if (!session?.host || !session.endsAt) {
    return;
  }

  const remainingMs = session.endsAt - Date.now();
  const notifyExpired = () => {
    if (expiryNotifiedStartedAt === session.startedAt) return;
    expiryNotifiedStartedAt = session.startedAt;

    const visible = document.visibilityState === "visible";
    if (visible) {
      showCelebrate({
        host: session.host,
        durationMinutes: session.durationMinutes,
        startedAt: session.startedAt,
      });
    }
    sendRuntimeMessage({ type: "sessionExpired", alreadyShown: visible });
  };

  if (remainingMs <= 0) {
    notifyExpired();
    return;
  }

  sessionExpiryTimer = setTimeout(notifyExpired, remainingMs + 50);
}

function showWarning(session) {
  if (
    shownSessionStartedAt === session.startedAt &&
    document.getElementById("wardkin-warn-root")
  ) {
    return;
  }

  hideWarning();

  const remainingMs = session.endsAt - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  shownSessionStartedAt = session.startedAt;
  warningExpiryTimer = setTimeout(() => {
    hideWarning();
  }, remainingMs + 50);

  const mount = () => {
    if (document.getElementById("wardkin-warn-root")) return;

    const root = document.createElement("div");
    root.id = "wardkin-warn-root";
    root.style.all = "initial";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483646";

    const shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host, .overlay {
          all: initial;
        }
        .overlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          background: rgba(17, 24, 39, 0.55);
          font-family: "Segoe UI", system-ui, sans-serif;
          pointer-events: auto;
        }
        .card {
          width: min(420px, 100%);
          padding: 24px;
          border-radius: 12px;
          background: #fff;
          color: #111827;
          text-align: center;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
        }
        h1 {
          margin: 0 0 8px;
          color: #b45309;
          font-size: 1.25rem;
          font-weight: 700;
        }
        p {
          margin: 0 0 8px;
          color: #4b5563;
          font-size: 14px;
          line-height: 1.4;
        }
        .remaining {
          margin-bottom: 16px;
          color: #6b7280;
          font-variant-numeric: tabular-nums;
        }
        .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: center;
        }
        button {
          border: 0;
          border-radius: 8px;
          padding: 10px 12px;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .return {
          background: #b45309;
          color: #fff;
        }
        .return:hover {
          background: #92400e;
        }
        .continue {
          background: #f3f4f6;
          color: #111827;
        }
        .continue:hover {
          background: #e5e7eb;
        }
      </style>
      <div class="overlay">
        <div class="card">
          <h1>Stay on task</h1>
          <p>You have a concentration session on <strong></strong>.</p>
          <p class="remaining"></p>
          <div class="actions">
            <button class="return" type="button">Return to site</button>
            <button class="continue" type="button">Continue anyway</button>
          </div>
        </div>
      </div>
    `;

    shadow.querySelector("strong").textContent = session.host;
    const remainingEl = shadow.querySelector(".remaining");
    const updateRemaining = () => {
      const remaining = session.endsAt - Date.now();
      if (remaining <= 0) {
        hideWarning();
        return;
      }
      remainingEl.textContent = `${formatRemaining(remaining)} remaining`;
    };
    updateRemaining();
    warningTimer = setInterval(updateRemaining, 1000);

    shadow.querySelector(".return").addEventListener("click", () => {
      sendRuntimeMessage({ type: "focusSessionHost" });
    });
    shadow.querySelector(".continue").addEventListener("click", () => {
      dismissWarning(session);
    });

    document.documentElement.appendChild(root);
  };

  document.documentElement.setAttribute(WARN_HOST_ATTR, "true");

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
}

function hideWarning() {
  stopWarningTimers();
  shownSessionStartedAt = null;
  document.documentElement.removeAttribute(WARN_HOST_ATTR);
  const root = document.getElementById("wardkin-warn-root");
  const tick = root?.dataset?.wardkinTick;
  if (tick) clearInterval(Number(tick));
  root?.remove();
}

let celebrateHideTimer = null;
let shownCelebrationStartedAt = null;

function hideCelebrate() {
  if (celebrateHideTimer) {
    clearTimeout(celebrateHideTimer);
    celebrateHideTimer = null;
  }
  document.getElementById("wardkin-celebrate-root")?.remove();
}

function maybeShowPendingCelebration(pending) {
  if (!pending?.startedAt) return;
  if (document.visibilityState !== "visible") return;
  const queuedAt = pending.queuedAt || pending.startedAt;
  if (Date.now() - queuedAt > 2 * 60 * 60 * 1000) return;
  showCelebrate(pending);
}

function showCelebrate(payload = {}) {
  const startedAt = payload.startedAt ?? null;
  if (startedAt != null && shownCelebrationStartedAt === startedAt) {
    return;
  }
  shownCelebrationStartedAt = startedAt;

  hideWarning();
  hideCelebrate();

  const mount = () => {
    if (document.getElementById("wardkin-celebrate-root")) return;

    const root = document.createElement("div");
    root.id = "wardkin-celebrate-root";
    root.style.position = "fixed";
    root.style.top = "16px";
    root.style.right = "20px";
    root.style.zIndex = "2147483647";

    const shadow = root.attachShadow({ mode: "closed" });
    let gargouSrc = "";
    try {
      gargouSrc = chrome.runtime.getURL("images/gargou.png");
    } catch {
      detachListeners();
      return;
    }
    shadow.innerHTML = `
      <style>
        .toast {
          box-sizing: border-box;
          width: 320px;
          padding: 20px 20px 18px;
          border-radius: 16px;
          background: #fff7ed;
          color: #111827;
          font-family: "Segoe UI", system-ui, sans-serif;
          text-align: center;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
        }
        img {
          display: block;
          width: 240px;
          height: 240px;
          margin: 0 auto 8px;
          image-rendering: pixelated;
        }
        strong {
          display: block;
          margin: 0 0 6px;
          font-size: 20px;
          font-weight: 700;
        }
        p {
          margin: 0 0 14px;
          color: #6b7280;
          font-size: 14px;
          line-height: 1.4;
        }
        button {
          width: 100%;
          border: 0;
          border-radius: 8px;
          padding: 10px 12px;
          background: #b45309;
          color: #fff;
          font: 600 14px/1.2 "Segoe UI", system-ui, sans-serif;
          cursor: pointer;
        }
        button:hover {
          background: #92400e;
        }
      </style>
      <div class="toast" role="status">
        <img alt="Gargou" width="240" height="240" />
        <strong>You did it!</strong>
        <p></p>
        <button type="button">Thanks, Gargou</button>
      </div>
    `;

    shadow.querySelector("img").src = gargouSrc;
    const minutes = Number.parseInt(payload.durationMinutes, 10);
    const details = minutes > 0 ? `${minutes}-minute session` : "session";
    shadow.querySelector("p").textContent = `Gargou is proud of you for finishing your ${details}.`;
    shadow.querySelector("button").addEventListener("click", hideCelebrate);

    document.documentElement.appendChild(root);
    if (startedAt != null) {
      sendRuntimeMessage({ type: "celebrationShown", startedAt });
    }
  };

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
}

async function applyState() {
  try {
    if (listenersDetached || !isExtensionAlive()) return;

    const result = await getLocal([
      STORAGE_KEY,
      SESSION_KEY,
      PENDING_KEY,
    ]);
    if (!result || listenersDetached || !isExtensionAlive()) return;

    const hosts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    const session = result[SESSION_KEY] || null;
    const sessionActive = isSessionActive(session);

    if (sessionActive) {
      hideCelebrate();
      shownCelebrationStartedAt = null;
    }

    if (isHostBlocked(hosts)) {
      hideWarning();
      showOverlay();
      armSessionExpiry(session);
      if (!sessionActive) {
        maybeShowPendingCelebration(result[PENDING_KEY]);
      }
      return;
    }

    hideOverlay();

    armSessionExpiry(session);

    if (isSessionActive(session) && !isSessionHost(session) && !wasWarningDismissed(session)) {
      showWarning(session);
    } else {
      hideWarning();
    }

    if (!sessionActive) {
      maybeShowPendingCelebration(result[PENDING_KEY]);
    }
  } catch {
    // Page is unloading or the extension was reloaded.
  }
}

refreshState();

try {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
} catch {
  detachListeners();
}

try {
  chrome.storage?.onChanged?.addListener(onStorageChanged);
} catch {
  detachListeners();
}

document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("pageshow", onPageShow);
window.addEventListener("pagehide", onPageHide);

globalThis.__wardkinApplyState = refreshState;
})();
