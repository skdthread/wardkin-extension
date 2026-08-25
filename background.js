const STORAGE_KEY = "blockedHosts";

function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
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

    sendResponse({ ok: false, error: "Unknown message" });
  })();

  return true;
});
