const STORAGE_KEY = "blockedHosts";
const OVERLAY_HOST_ATTR = "data-wardkin-overlay";

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

async function applyBlockState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const hosts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];

  if (isHostBlocked(hosts)) {
    showOverlay();
  } else {
    hideOverlay();
  }
}

applyBlockState();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    applyBlockState();
  }
});
