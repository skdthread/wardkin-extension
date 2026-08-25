const currentHostEl = document.getElementById("current-host");
const blockBtn = document.getElementById("block-btn");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("blocked-list");
const emptyStateEl = document.getElementById("empty-state");

let currentHost = null;

function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function setStatus(message) {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
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

async function loadHosts() {
  const response = await chrome.runtime.sendMessage({ type: "getBlockedHosts" });
  const hosts = response?.hosts || [];
  renderList(hosts);
  updateBlockButton(hosts);
  return hosts;
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

init();
