const STORAGE_KEY = "blockedHosts";
const SESSION_KEY = "concentrationSession";
const SESSION_ALARM = "concentrationSessionEnd";
const CELEBRATED_KEY = "celebratedSessionAt";
const PENDING_KEY = "pendingCelebration";
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_SESSION_MINUTES = 1;
const MAX_SESSION_MINUTES = 180;

let finishSessionPromise = null;

function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function hostFromUrl(urlString) {
  try {
    const url = new URL(urlString || "");
    if (!/^https?:$/i.test(url.protocol)) return null;
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

function isSameSite(host, sessionHost) {
  return host === sessionHost || host.endsWith(`.${sessionHost}`);
}

async function getBlockedHosts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function setBlockedHosts(hosts) {
  const unique = [...new Set(hosts.map(normalizeHost).filter(Boolean))].sort();
  await chrome.storage.local.set({ [STORAGE_KEY]: unique });
  return unique;
}

async function getStoredSession() {
  const result = await chrome.storage.local.get(SESSION_KEY);
  return result[SESSION_KEY] || null;
}

async function clearSession() {
  await chrome.alarms.clear(SESSION_ALARM);
  await chrome.storage.local.remove(SESSION_KEY);
}

function isPendingFresh(pending) {
  if (!pending?.startedAt) return false;
  const queuedAt = pending.queuedAt || pending.startedAt;
  return Date.now() - queuedAt < PENDING_TTL_MS;
}

function celebrationPayload(session) {
  return {
    startedAt: session.startedAt,
    host: session.host,
    durationMinutes: session.durationMinutes,
    queuedAt: Date.now(),
  };
}

async function markCelebrationShown(startedAt) {
  if (startedAt == null) return;
  await chrome.storage.local.set({ [CELEBRATED_KEY]: startedAt });
  await chrome.storage.local.remove(PENDING_KEY);
}

async function getLastFocusedNormalTab() {
  try {
    const win = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    return win?.tabs?.find((tab) => tab.active) || null;
  } catch {
    return null;
  }
}

async function sendCelebration(tabId, payload) {
  await chrome.tabs.sendMessage(tabId, {
    type: "sessionComplete",
    host: payload.host,
    durationMinutes: payload.durationMinutes,
    startedAt: payload.startedAt,
  });
}

async function deliverCelebration(payload) {
  const seen = new Set();
  const candidates = [];

  const focused = await getLastFocusedNormalTab();
  if (focused) candidates.push(focused);

  const activeTabs = await chrome.tabs.query({ active: true });
  candidates.push(...activeTabs);

  for (const tab of candidates) {
    if (!tab?.id || seen.has(tab.id)) continue;
    if (tab.url && !/^https?:/i.test(tab.url)) continue;
    seen.add(tab.id);
    try {
      await sendCelebration(tab.id, payload);
      return true;
    } catch {
      // No content script on this tab (chrome://, PDF, new tab, and similar).
    }
  }

  return false;
}

async function openCelebration(session, { alreadyShown = false } = {}) {
  const result = await chrome.storage.local.get([CELEBRATED_KEY, PENDING_KEY]);
  if (result[CELEBRATED_KEY] === session.startedAt) {
    await chrome.storage.local.remove(PENDING_KEY);
    return;
  }

  if (alreadyShown) {
    await markCelebrationShown(session.startedAt);
    return;
  }

  const payload =
    result[PENDING_KEY]?.startedAt === session.startedAt
      ? result[PENDING_KEY]
      : celebrationPayload(session);

  await chrome.storage.local.set({ [PENDING_KEY]: payload });
  await deliverCelebration(payload);
}

async function recoverPendingCelebration() {
  const result = await chrome.storage.local.get([CELEBRATED_KEY, PENDING_KEY]);
  const pending = result[PENDING_KEY];
  if (!isPendingFresh(pending)) {
    if (pending) await chrome.storage.local.remove(PENDING_KEY);
    return;
  }
  if (result[CELEBRATED_KEY] === pending.startedAt) {
    await chrome.storage.local.remove(PENDING_KEY);
    return;
  }
  await deliverCelebration(pending);
}

async function finishSession({ celebrate = false, alreadyShown = false } = {}) {
  if (finishSessionPromise) {
    return finishSessionPromise;
  }

  finishSessionPromise = (async () => {
    const session = await getStoredSession();
    if (!session?.host) {
      if (alreadyShown) {
        const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
        if (pending?.startedAt) {
          await markCelebrationShown(pending.startedAt);
        }
      }
      return;
    }

    await clearSession();
    await clearOpenTabWarnings();
    if (celebrate) {
      await openCelebration(session, { alreadyShown });
      return;
    }
    await chrome.storage.local.remove(PENDING_KEY);
  })().finally(() => {
    finishSessionPromise = null;
  });

  return finishSessionPromise;
}

async function recoverExpiredSession() {
  const session = await getStoredSession();
  if (session?.endsAt && Date.now() >= session.endsAt) {
    await finishSession({ celebrate: true });
    return;
  }
  await recoverPendingCelebration();
}

async function getActiveSession() {
  const session = await getStoredSession();
  if (!session?.host || !session.endsAt) {
    return null;
  }
  if (Date.now() >= session.endsAt) {
    await finishSession({ celebrate: true });
    return null;
  }
  return session;
}

async function startSession(host, minutes) {
  const normalized = normalizeHost(host || "");
  const durationMinutes = Number.parseInt(minutes, 10);

  if (!normalized) {
    return { ok: false, error: "Open a website to start a session" };
  }
  if (
    Number.isNaN(durationMinutes) ||
    durationMinutes < MIN_SESSION_MINUTES ||
    durationMinutes > MAX_SESSION_MINUTES
  ) {
    return {
      ok: false,
      error: `Choose a duration between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES} minutes`,
    };
  }

  const startedAt = Date.now();
  const session = {
    host: normalized,
    durationMinutes,
    startedAt,
    endsAt: startedAt + durationMinutes * 60 * 1000,
  };

  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await chrome.storage.local.remove(PENDING_KEY);
  await chrome.alarms.clear(SESSION_ALARM);
  await chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
  pingOpenTabs().catch(() => {});
  return { ok: true, session };
}

async function focusSessionHost() {
  const session = await getActiveSession();
  if (!session) {
    return { ok: false, error: "No active session" };
  }

  const tabs = await chrome.tabs.query({});
  const match = tabs.find((tab) => {
    const host = hostFromUrl(tab.url);
    return host && isSameSite(host, session.host);
  });

  if (match) {
    await chrome.windows.update(match.windowId, { focused: true });
    await chrome.tabs.update(match.id, { active: true });
    return { ok: true };
  }

  await chrome.tabs.create({ url: `https://${session.host}` });
  return { ok: true, created: true };
}

function injectStayOnTaskWarning(session) {
  const dismissKey = "wardkinSessionDismissed";
  if (!session?.host || !session.endsAt || session.endsAt <= Date.now()) return;
  if (document.getElementById("wardkin-warn-root")) return;

  const host = (window.location.hostname || "")
    .replace(/^www\./i, "")
    .toLowerCase();
  if (host === session.host || host.endsWith(`.${session.host}`)) return;

  try {
    if (sessionStorage.getItem(dismissKey) === String(session.startedAt)) return;
  } catch {
    // Ignore quota or disabled storage.
  }

  const formatRemaining = (ms) => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
    }
    return `${minutes}:${seconds}`;
  };

  const root = document.createElement("div");
  root.id = "wardkin-warn-root";
  root.style.all = "initial";
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "2147483646";

  const shadow = root.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host, .overlay { all: initial; }
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
      .return { background: #b45309; color: #fff; }
      .return:hover { background: #92400e; }
      .continue { background: #f3f4f6; color: #111827; }
      .continue:hover { background: #e5e7eb; }
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
  let intervalId = 0;
  const updateRemaining = () => {
    const remaining = session.endsAt - Date.now();
    if (remaining <= 0) {
      clearInterval(intervalId);
      root.remove();
      document.documentElement.removeAttribute("data-wardkin-warning");
      return;
    }
    remainingEl.textContent = `${formatRemaining(remaining)} remaining`;
  };
  updateRemaining();
  intervalId = setInterval(updateRemaining, 1000);
  root.dataset.wardkinTick = String(intervalId);
  document.documentElement.setAttribute("data-wardkin-warning", "true");

  shadow.querySelector(".return").addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "focusSessionHost" });
    } catch {
      // Extension context unavailable.
    }
  });
  shadow.querySelector(".continue").addEventListener("click", () => {
    try {
      sessionStorage.setItem(dismissKey, String(session.startedAt));
    } catch {
      // Ignore quota or disabled storage.
    }
    clearInterval(intervalId);
    root.remove();
    document.documentElement.removeAttribute("data-wardkin-warning");
  });

  document.documentElement.appendChild(root);
}

function removeStayOnTaskWarning() {
  const root = document.getElementById("wardkin-warn-root");
  const tick = root?.dataset?.wardkinTick;
  if (tick) clearInterval(Number(tick));
  root?.remove();
  document.documentElement.removeAttribute("data-wardkin-warning");
}

async function pingTabApplyState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "applyState" });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function requestApplyState(tabId, url) {
  const session = await getActiveSession();
  if (!session || !tabId) return;
  if (url && !/^https?:/i.test(url)) return;

  const host = hostFromUrl(url);
  if (host && isSameSite(host, session.host)) return;

  if (await pingTabApplyState(tabId)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: injectStayOnTaskWarning,
      args: [
        {
          host: session.host,
          durationMinutes: session.durationMinutes,
          startedAt: session.startedAt,
          endsAt: session.endsAt,
        },
      ],
    });
  } catch {
    // Tab cannot be scripted (chrome://, PDF, new tab, and similar).
  }
}

async function pingOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => requestApplyState(tab.id, tab.url)));
}

async function clearOpenTabWarnings() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab?.id) return;
      if (tab.url && !/^https?:/i.test(tab.url)) return;

      try {
        if (await pingTabApplyState(tab.id)) return;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "ISOLATED",
          func: removeStayOnTaskWarning,
        });
      } catch {
        // Tab cannot be scripted (chrome://, PDF, new tab, and similar).
      }
    })
  );
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs
    .get(activeInfo.tabId)
    .then((tab) => requestApplyState(tab.id, tab.url))
    .catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs
    .query({ active: true, windowId })
    .then((tabs) => {
      const tab = tabs[0];
      if (tab) return requestApplyState(tab.id, tab.url);
    })
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  requestApplyState(tabId, tab.url);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SESSION_ALARM) {
    finishSession({ celebrate: true });
  }
});

chrome.runtime.onStartup.addListener(() => {
  recoverExpiredSession();
});

chrome.runtime.onInstalled.addListener(() => {
  recoverExpiredSession();
});

recoverExpiredSession();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "getBlockedHosts") {
      sendResponse({ hosts: await getBlockedHosts() });
      return;
    }

    if (message?.type === "addBlockedHost") {
      const host = normalizeHost(message.host || "");
      if (!host) {
        sendResponse({ ok: false, error: "Invalid host" });
        return;
      }
      const hosts = await getBlockedHosts();
      if (!hosts.includes(host)) {
        hosts.push(host);
      }
      const updated = await setBlockedHosts(hosts);
      sendResponse({ ok: true, hosts: updated });
      return;
    }

    if (message?.type === "removeBlockedHost") {
      const host = normalizeHost(message.host || "");
      const hosts = await getBlockedHosts();
      const updated = await setBlockedHosts(hosts.filter((h) => h !== host));
      sendResponse({ ok: true, hosts: updated });
      return;
    }

    if (message?.type === "getSession") {
      sendResponse({ session: await getActiveSession() });
      return;
    }

    if (message?.type === "startSession") {
      sendResponse(await startSession(message.host, message.minutes));
      return;
    }

    if (message?.type === "endSession") {
      await finishSession({ celebrate: false });
      sendResponse({ ok: true, session: null });
      return;
    }

    if (message?.type === "sessionExpired") {
      await finishSession({
        celebrate: true,
        alreadyShown: Boolean(message.alreadyShown),
      });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "celebrationShown") {
      await markCelebrationShown(message.startedAt);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "focusSessionHost") {
      sendResponse(await focusSessionHost());
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })();

  return true;
});
