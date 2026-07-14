const stateLabel = document.getElementById("stateLabel");
const stateDot = document.getElementById("stateDot");
const queuedCount = document.getElementById("queuedCount");
const scrapingCount = document.getElementById("scrapingCount");
const cachedCount = document.getElementById("cachedCount");
const reviewCount = document.getElementById("reviewCount");
const hiddenCount = document.getElementById("hiddenCount");
const unhideAllButton = document.getElementById("unhideAllButton");
const progressList = document.getElementById("progressList");
const resumeButton = document.getElementById("resumeButton");
const refreshButton = document.getElementById("refreshButton");
const dashboardButton = document.getElementById("dashboardButton");
const clearButton = document.getElementById("clearButton");
const HIDDEN_BUILDINGS_KEY = "hidden:buildings";

let refreshTimer = null;

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

function stateText(status) {
  if (status.queuePaused) return "Paused (CAPTCHA)";
  if (status.processing || status.counts.scraping || status.counts.queued) return "Scraping...";
  return "Idle";
}

function renderStatus(status) {
  stateLabel.textContent = stateText(status);
  stateDot.className = `state-dot ${status.queuePaused ? "paused" : status.processing ? "busy" : "idle"}`;
  queuedCount.textContent = status.counts.queued;
  scrapingCount.textContent = status.counts.scraping;
  cachedCount.textContent = status.counts.cachedBuildings;
  reviewCount.textContent = `${status.counts.cachedReviewsTotal} cached review snippets`;
  resumeButton.hidden = !status.queuePaused;

  const rows = status.inProgress.slice(0, 8);
  progressList.innerHTML = rows.length
    ? rows.map((item) => `
        <div class="row">
          <span class="building" title="${escapeHtml(item.building)}">${escapeHtml(item.building)}</span>
          <span class="status">${escapeHtml(item.status)}</span>
        </div>
      `).join("")
    : `<div class="empty">No active scraping work.</div>`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderHiddenBuildings(value) {
  const hiddenBuildings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const count = Object.keys(hiddenBuildings).length;
  hiddenCount.textContent = String(count);
  unhideAllButton.disabled = count === 0;
}

async function refreshHiddenBuildings() {
  const stored = await chrome.storage.local.get(HIDDEN_BUILDINGS_KEY);
  renderHiddenBuildings(stored && stored[HIDDEN_BUILDINGS_KEY]);
}

async function unhideAllBuildings() {
  await chrome.storage.local.set({ [HIDDEN_BUILDINGS_KEY]: {} });
}

async function refresh() {
  const [response] = await Promise.all([
    sendMessage({ type: "GET_STATUS" }),
    refreshHiddenBuildings()
  ]);
  if (response && response.ok && response.status) {
    renderStatus(response.status);
    return;
  }
  stateLabel.textContent = "Worker unavailable";
}

async function clearCache() {
  clearButton.disabled = true;
  await sendMessage({ type: "CLEAR_CACHE" });
  clearButton.disabled = false;
  await refresh();
}

async function resumeScraping() {
  resumeButton.disabled = true;
  await sendMessage({ type: "RESUME_QUEUE" });
  resumeButton.disabled = false;
  await refresh();
}

refreshButton.addEventListener("click", refresh);
dashboardButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/dashboard.html") });
});
clearButton.addEventListener("click", clearCache);
resumeButton.addEventListener("click", resumeScraping);
unhideAllButton.addEventListener("click", () => {
  unhideAllBuildings().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[HIDDEN_BUILDINGS_KEY]) return;
  renderHiddenBuildings(changes[HIDDEN_BUILDINGS_KEY].newValue);
});

refresh();
refreshTimer = setInterval(refresh, 1000);

window.addEventListener("unload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
