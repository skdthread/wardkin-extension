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
