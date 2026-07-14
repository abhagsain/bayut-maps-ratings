const statusStrip = document.getElementById("statusStrip");
const filterInput = document.getElementById("filterInput");
const refreshButton = document.getElementById("refreshButton");
const clearButton = document.getElementById("clearButton");
const cacheBody = document.getElementById("cacheBody");
const hiddenBuildingsBody = document.getElementById("hiddenBuildingsBody");
const unhideAllButton = document.getElementById("unhideAllButton");
const HIDDEN_BUILDINGS_KEY = "hidden:buildings";

let cacheEntries = [];
let hiddenBuildings = {};
let sortKey = "scrapedAt";
let sortDirection = "desc";
let statusTimer = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "Never";
  return new Date(Number(value)).toLocaleString();
}

function formatRating(value) {
  return value == null || Number.isNaN(Number(value)) ? "-" : Number(value).toFixed(1);
}

function compareValues(a, b) {
  if (sortKey === "building") {
    return String(a.building || "").localeCompare(String(b.building || ""));
  }
  return Number(a[sortKey] || 0) - Number(b[sortKey] || 0);
}

function renderTable() {
  const filter = filterInput.value.trim().toLowerCase();
  const rows = cacheEntries
    .filter((entry) => !filter || String(entry.building || "").toLowerCase().includes(filter))
    .sort((a, b) => {
      const result = compareValues(a, b);
      return sortDirection === "asc" ? result : -result;
    });

  cacheBody.innerHTML = rows.length
    ? rows.map((entry) => `
        <tr>
          <td>${escapeHtml(entry.building || "Unknown building")}</td>
          <td>${escapeHtml(formatRating(entry.rating))}</td>
          <td>
            ${entry.reviewCount == null ? "-" : Number(entry.reviewCount).toLocaleString()}
            <div class="muted">${entry.reviewsCount || 0} snippets cached</div>
          </td>
          <td>${escapeHtml(formatDate(entry.scrapedAt))}</td>
          <td>${entry.mapsUrl ? `<a href="${escapeHtml(entry.mapsUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : "-"}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="5" class="muted">No cached buildings match this filter.</td></tr>`;
}

function renderHiddenBuildings() {
  const rows = Object.entries(hiddenBuildings)
    .sort((a, b) => Number(b[1].hiddenAt || 0) - Number(a[1].hiddenAt || 0));
  unhideAllButton.disabled = rows.length === 0;
  hiddenBuildingsBody.innerHTML = rows.length
    ? rows.map(([key, entry]) => `
        <tr>
          <td>${escapeHtml(entry.label || "Hidden building")}</td>
          <td>${escapeHtml(entry.neighbourhood || "-")}</td>
          <td>${escapeHtml(formatRating(entry.rating))}</td>
          <td>${escapeHtml(formatDate(entry.hiddenAt))}</td>
          <td><button type="button" class="unhide-button" data-building-key="${escapeHtml(key)}">Unhide</button></td>
        </tr>
      `).join("")
    : `<tr><td colspan="5" class="muted">No hidden buildings.</td></tr>`;
}

async function refreshHiddenBuildings() {
  const stored = await chrome.storage.local.get(HIDDEN_BUILDINGS_KEY);
  const value = stored && stored[HIDDEN_BUILDINGS_KEY];
  hiddenBuildings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  renderHiddenBuildings();
}

async function unhideBuilding(buildingKey) {
  const stored = await chrome.storage.local.get(HIDDEN_BUILDINGS_KEY);
  const current = stored && stored[HIDDEN_BUILDINGS_KEY] && typeof stored[HIDDEN_BUILDINGS_KEY] === "object"
    ? stored[HIDDEN_BUILDINGS_KEY]
    : {};
  if (!Object.prototype.hasOwnProperty.call(current, buildingKey)) return;
  delete current[buildingKey];
  await chrome.storage.local.set({ [HIDDEN_BUILDINGS_KEY]: current });
}

async function unhideAllBuildings() {
  await chrome.storage.local.set({ [HIDDEN_BUILDINGS_KEY]: {} });
}

async function refreshCache() {
  const response = await sendMessage({ type: "GET_CACHE_LIST" });
  cacheEntries = response && response.ok && Array.isArray(response.entries) ? response.entries : [];
  renderTable();
}

async function refreshStatus() {
  const response = await sendMessage({ type: "GET_STATUS" });
  if (!response || !response.ok || !response.status) {
    statusStrip.textContent = "Scraping status unavailable.";
    return;
  }

  const status = response.status;
  const state = status.queuePaused ? "Paused (CAPTCHA)" : status.processing ? "Scraping" : "Idle";
  statusStrip.textContent = `${state} · queued ${status.counts.queued} · scraping ${status.counts.scraping} · cached ${status.counts.cachedBuildings} buildings (${status.counts.cachedReviewsTotal} snippets)`;
}

async function clearCache() {
  clearButton.disabled = true;
  await sendMessage({ type: "CLEAR_CACHE" });
  clearButton.disabled = false;
  await Promise.all([refreshCache(), refreshStatus()]);
}

filterInput.addEventListener("input", renderTable);
refreshButton.addEventListener("click", () => {
  refreshCache();
  refreshStatus();
});
clearButton.addEventListener("click", clearCache);
unhideAllButton.addEventListener("click", () => {
  unhideAllBuildings().catch(() => {});
});
hiddenBuildingsBody.addEventListener("click", (event) => {
  const button = event.target.closest(".unhide-button");
  if (!button) return;
  unhideBuilding(button.dataset.buildingKey || "").catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HIDDEN_BUILDINGS_KEY]) return;
  const value = changes[HIDDEN_BUILDINGS_KEY].newValue;
  hiddenBuildings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  renderHiddenBuildings();
});

document.querySelectorAll("th[data-sort]").forEach((header) => {
  header.addEventListener("click", () => {
    const nextKey = header.dataset.sort;
    if (sortKey === nextKey) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = nextKey;
      sortDirection = nextKey === "building" ? "asc" : "desc";
    }
    renderTable();
  });
  header.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      header.click();
    }
  });
});

refreshCache();
refreshStatus();
refreshHiddenBuildings();
statusTimer = setInterval(refreshStatus, 2000);

window.addEventListener("unload", () => {
  if (statusTimer) clearInterval(statusTimer);
});
