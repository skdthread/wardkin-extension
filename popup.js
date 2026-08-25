const currentHostEl = document.getElementById("current-host");
const blockBtn = document.getElementById("block-btn");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("blocked-list");
const emptyStateEl = document.getElementById("empty-state");
const sessionIdleEl = document.getElementById("session-idle");
const sessionActiveEl = document.getElementById("session-active");
const sessionMinutesEl = document.getElementById("session-minutes");
const startSessionBtn = document.getElementById("start-session-btn");
const endSessionBtn = document.getElementById("end-session-btn");
const sessionFocusEl = document.getElementById("session-focus");
const sessionRemainingEl = document.getElementById("session-remaining");

let currentHost = null;
let remainingTimer = null;

function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function setStatus(message) {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
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

function stopRemainingTimer() {
  if (remainingTimer) {
    clearInterval(remainingTimer);
    remainingTimer = null;
  }
}

function renderList(hosts) {
  listEl.innerHTML = "";
  emptyStateEl.hidden = hosts.length > 0;

  for (const host of hosts) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = host;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const response = await chrome.runtime.sendMessage({
        type: "removeBlockedHost",
        host,
      });
      if (response?.ok) {
        renderList(response.hosts);
        updateBlockButton(response.hosts);
        setStatus(`Removed ${host}`);
      }
    });

    li.append(label, removeBtn);
    listEl.append(li);
  }
}

function updateBlockButton(hosts) {
  if (!currentHost) {
    blockBtn.disabled = true;
    blockBtn.textContent = "Block this site";
    return;
  }

  const alreadyBlocked = hosts.includes(currentHost);
  blockBtn.disabled = alreadyBlocked;
  blockBtn.textContent = alreadyBlocked
    ? "Already blocked"
    : "Block this site";
}

function renderSession(session) {
  stopRemainingTimer();

  const active = Boolean(session?.host && session.endsAt > Date.now());
  sessionIdleEl.hidden = active;
  sessionActiveEl.hidden = !active;
  startSessionBtn.disabled = active || !currentHost;

  if (!active) {
    return;
  }

  sessionFocusEl.textContent = `Focusing on ${session.host}`;

  const updateRemaining = () => {
    const remaining = session.endsAt - Date.now();
    if (remaining <= 0) {
      stopRemainingTimer();
      renderSession(null);
      return;
    }
    sessionRemainingEl.textContent = `${formatRemaining(remaining)} remaining`;
  };

  updateRemaining();
  remainingTimer = setInterval(updateRemaining, 1000);
}

async function loadHosts() {
  const response = await chrome.runtime.sendMessage({ type: "getBlockedHosts" });
  const hosts = response?.hosts || [];
  renderList(hosts);
  updateBlockButton(hosts);
  return hosts;
}

async function loadSession() {
  const response = await chrome.runtime.sendMessage({ type: "getSession" });
  renderSession(response?.session || null);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const url = new URL(tab?.url || "");
    if (!/^https?:$/i.test(url.protocol)) {
      throw new Error("Not a website");
    }
    currentHost = normalizeHost(url.hostname);
    currentHostEl.textContent = currentHost;
  } catch {
    currentHost = null;
    currentHostEl.textContent = "Open a website to block it";
    blockBtn.disabled = true;
  }

  await loadHosts();
  await loadSession();
}

blockBtn.addEventListener("click", async () => {
  if (!currentHost) return;

  blockBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "addBlockedHost",
    host: currentHost,
  });

  if (response?.ok) {
    renderList(response.hosts);
    updateBlockButton(response.hosts);
    setStatus(`Blocked ${currentHost}`);
  } else {
    blockBtn.disabled = false;
    setStatus(response?.error || "Could not block site");
  }
});

startSessionBtn.addEventListener("click", async () => {
  if (!currentHost) return;

  const minutes = Number(sessionMinutesEl.value);
  startSessionBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "startSession",
    host: currentHost,
    minutes,
  });

  if (response?.ok) {
    renderSession(response.session);
    setStatus(`Session started on ${currentHost}`);
  } else {
    startSessionBtn.disabled = !currentHost;
    setStatus(response?.error || "Could not start session");
  }
});

endSessionBtn.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "endSession" });
  if (response?.ok) {
    renderSession(null);
    setStatus("Session ended");
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && changes.concentrationSession) {
    renderSession(changes.concentrationSession.newValue || null);
  }
});

init().catch(() => {});
