const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const JITTER_MIN_MS = 500;
const JITTER_MAX_MS = 1500;
const TAB_LOAD_TIMEOUT_MS = 25000;
const KEEPALIVE_INTERVAL_MS = 20000;
const CAPTCHA_RECHECK_INTERVAL_MS = 15000;
const MAX_CONCURRENCY = 3;
const RESULTS_LIST_ACCEPT_M = 600;
const FINAL_PLACE_ACCEPT_M = 700;
const PENDING_QUEUE_KEY = "queue:pending";
const SCRAPER_TABS_KEY = "queue:scraperTabs";
const RESUME_ALARM_NAME = "resume-queue";
const LOG_PREFIX = "[BayutRatings][worker]";

const hitsByTab = new Map();
const queuedByBuilding = new Map();
const queue = [];
const activeEntries = new Set();
const poolTabs = [];

let dispatching = false;
let keepaliveTimer = null;
let queuePaused = false;
let captchaTabId = null;
let captchaWatchTimer = null;
let captchaWatchRunning = false;
let sessionDoneCount = 0;

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function alarmsAvailable() {
  return Boolean(chrome.alarms && chrome.alarms.create && chrome.alarms.onAlarm);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "BAYUT_HITS") {
    rememberHits(sender.tab && sender.tab.id, message.hits);
    log(`remembered ${Array.isArray(message.hits) ? message.hits.length : 0} hits for tab ${sender.tab && sender.tab.id ? sender.tab.id : "unknown"}`);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_STATUS") {
    getStatusSnapshot()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      }));
    return true;
  }

  if (message.type === "GET_CACHE_LIST") {
    getCacheList()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      }));
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      }));
    return true;
  }

  if (message.type === "GET_DEBUG_HTML") {
    getDebugHtml(message.key)
      .then((debug) => sendResponse({ ok: true, debug }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      }));
    return true;
  }

  if (message.type === "RESUME_QUEUE") {
    resumeQueue()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      }));
    return true;
  }

  if (message.type === "LOOKUP_LISTING") {
    lookupListing(message, sender.tab && sender.tab.id)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        result: {
          status: "error",
          error: String(error && error.message ? error.message : error)
        }
      }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  hitsByTab.delete(tabId);
  if (tabId === captchaTabId) {
    captchaTabId = null;
    stopCaptchaWatcher();
  }
  const poolTab = poolTabs.find((tab) => tab.id === tabId);
  if (poolTab) {
    poolTab.closed = true;
    poolTab.busy = false;
  }
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === RESUME_ALARM_NAME) {
      restorePendingQueue().catch(() => {});
    }
  });
}

const initPromise = initializeWorker();

async function initializeWorker() {
  log(`started (alarms=${alarmsAvailable()})`);
  if (chrome.alarms && chrome.alarms.create) {
    try {
      chrome.alarms.create(RESUME_ALARM_NAME, { periodInMinutes: 1 });
    } catch (_error) {
      // alarms unavailable (permission not yet granted) — keepalive + content re-check still cover resume.
    }
  }
  await cleanupOrphanScraperTabs().catch(() => {});
  await restorePendingQueue().catch(() => {});
}

function rememberHits(tabId, hits) {
  if (!tabId || !Array.isArray(hits)) return;
  const existing = hitsByTab.get(tabId) || new Map();
  hits.forEach((hit) => {
    if (hit && hit.externalID) existing.set(String(hit.externalID), normalizeHit(hit));
  });
  hitsByTab.set(tabId, existing);
}

async function lookupListing(message, tabId) {
  await initPromise;
  const externalID = String(message.externalID || "");
  const storedHit = tabId && hitsByTab.get(tabId) ? hitsByTab.get(tabId).get(externalID) : null;
  const hit = normalizeHit(message.hit || storedHit);

  if (!externalID) return { status: "error", error: "Missing Bayut listing ID." };
  if (!hit) return { status: "error", error: "Waiting for Bayut listing data." };

  const buildingKey = makeBuildingKey(hit);
  const cached = await readCachedResult(buildingKey);
  if (cached) {
    log(`lookup id=${externalID} -> cacheHit=true`);
    notifyTab(tabId, externalID, cached);
    return cached;
  }

  return enqueueLookup({ externalID, tabId, hit, buildingKey });
}

function normalizeHit(hit) {
  if (!hit || !hit.geography) return null;
  const lat = Number(hit.geography.lat);
  const lng = Number(hit.geography.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    externalID: String(hit.externalID || ""),
    geography: { lat, lng },
    building: hit.building ? String(hit.building) : "",
    neighbourhood: hit.neighbourhood ? String(hit.neighbourhood) : "",
    title: hit.title ? String(hit.title) : ""
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function roundedCoord(value) {
  return Number(value).toFixed(5);
}

function makeBuildingKey(hit) {
  const name = normalizeText(hit.building || hit.neighbourhood || hit.title || "coordinates");
  return `${name}:${roundedCoord(hit.geography.lat)}:${roundedCoord(hit.geography.lng)}`;
}

function buildingCacheKey(buildingKey) {
  return `building:${buildingKey}`;
}

function placeCacheKey(placeId) {
  return `place:${placeId}`;
}

function isFresh(scrapedAt) {
  return Number.isFinite(Number(scrapedAt)) && Date.now() - Number(scrapedAt) < CACHE_TTL_MS;
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function storageSet(values) {
  return chrome.storage.local.set(values);
}

async function storageGetAll() {
  return chrome.storage.local.get(null);
}

async function readCachedResult(buildingKey) {
  const buildingKeyName = buildingCacheKey(buildingKey);
  const buildingEntry = (await storageGet(buildingKeyName))[buildingKeyName];
  if (!buildingEntry) return null;

  if (buildingEntry.noMatch && isFresh(buildingEntry.scrapedAt)) {
    return {
      status: "noMatch",
      noMatch: true,
      scrapedAt: buildingEntry.scrapedAt
    };
  }

  if (!buildingEntry.placeId) return null;
  const placeKeyName = placeCacheKey(buildingEntry.placeId);
  const placeEntry = (await storageGet(placeKeyName))[placeKeyName];
  if (!placeEntry || !isFresh(placeEntry.scrapedAt)) return null;

  return {
    ...placeEntry,
    status: "done"
  };
}

async function getStatusSnapshot() {
  const cacheStats = await getCacheStats();
  return {
    processing: dispatching || activeEntries.size > 0 || queue.length > 0,
    queuePaused,
    counts: {
      queued: queue.length,
      scraping: activeEntries.size,
      done: sessionDoneCount,
      cachedBuildings: cacheStats.cachedBuildings,
      cachedReviewsTotal: cacheStats.cachedReviewsTotal
    },
    inProgress: [
      ...Array.from(activeEntries).map((entry) => ({
        building: hitLabel(entry.hit),
        status: "scraping"
      })),
      ...queue.map((entry) => ({
        building: hitLabel(entry.hit),
        status: "queued"
      }))
    ],
    poolSize: poolTabs.filter((tab) => !tab.closed).length,
    concurrency: MAX_CONCURRENCY
  };
}

async function getCacheStats() {
  const all = await storageGetAll();
  const buildingKeys = Object.keys(all).filter((key) => key.startsWith("building:"));
  const placeKeys = Object.keys(all).filter((key) => key.startsWith("place:"));
  const cachedReviewsTotal = placeKeys.reduce((total, key) => {
    const entry = all[key];
    return total + (Array.isArray(entry && entry.reviews) ? entry.reviews.length : 0);
  }, 0);

  return {
    cachedBuildings: buildingKeys.length,
    cachedReviewsTotal
  };
}

async function clearCache() {
  const all = await storageGetAll();
  const keys = Object.keys(all).filter((key) => key.startsWith("building:") || key.startsWith("place:"));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
  return { cleared: keys.length };
}

async function getCacheList() {
  const all = await storageGetAll();
  return Object.entries(all)
    .filter(([key]) => key.startsWith("building:"))
    .map(([key, buildingEntry]) => {
      const placeId = buildingEntry && buildingEntry.placeId ? buildingEntry.placeId : "";
      const placeEntry = placeId ? all[placeCacheKey(placeId)] : null;
      if (!placeEntry && !(buildingEntry && buildingEntry.noMatch)) return null;

      return {
        building: displayBuildingName(key, buildingEntry, placeEntry),
        rating: placeEntry && placeEntry.rating != null ? placeEntry.rating : null,
        reviewCount: placeEntry && placeEntry.reviewCount != null ? placeEntry.reviewCount : null,
        distribution: placeEntry && placeEntry.distribution ? placeEntry.distribution : null,
        placeId,
        mapsUrl: placeEntry && placeEntry.mapsUrl ? placeEntry.mapsUrl : buildingEntry && buildingEntry.mapsUrl ? buildingEntry.mapsUrl : "",
        scrapedAt: placeEntry && placeEntry.scrapedAt ? placeEntry.scrapedAt : buildingEntry.scrapedAt || buildingEntry.updatedAt || null,
        reviewsCount: Array.isArray(placeEntry && placeEntry.reviews) ? placeEntry.reviews.length : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.scrapedAt || 0) - Number(a.scrapedAt || 0));
}

function displayBuildingName(buildingKeyName, buildingEntry, placeEntry) {
  if (buildingEntry && buildingEntry.building) return buildingEntry.building;
  if (placeEntry && placeEntry.building) return placeEntry.building;
  if (buildingEntry && buildingEntry.neighbourhood) return buildingEntry.neighbourhood;
  if (placeEntry && placeEntry.neighbourhood) return placeEntry.neighbourhood;

  const raw = buildingKeyName.replace(/^building:/, "").split(":").slice(0, -2).join(":");
  return raw
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown building";
}

async function getDebugHtml(key) {
  const storageKey = key
    ? String(key).startsWith("debug:html:")
      ? String(key)
      : `debug:html:${key}`
    : "debug:html:last";
  return (await storageGet(storageKey))[storageKey] || null;
}

async function storeDebugHtml(entry, result) {
  if (!result || !result.debugHtml) return;
  const html = String(result.debugHtml).slice(0, 250000);
  const debugId = result.placeId || entry.buildingKey;
  const record = {
    building: hitLabel(entry.hit),
    url: result.mapsUrl || "",
    html,
    at: Date.now()
  };
  await storageSet({
    "debug:html:last": record,
    [`debug:html:${debugId}`]: record
  });
  await pruneDebugHtml();
  log(`stored debug html for "${hitLabel(entry.hit)}" (${html.length} bytes)`);
}

async function pruneDebugHtml() {
  const all = await storageGetAll();
  const debugEntries = Object.entries(all)
    .filter(([key]) => key.startsWith("debug:html:") && key !== "debug:html:last")
    .map(([key, value]) => ({ key, at: Number(value && value.at ? value.at : 0) }))
    .sort((a, b) => b.at - a.at);
  const stale = debugEntries.slice(5).map((entry) => entry.key);
  if (stale.length) {
    await chrome.storage.local.remove(stale);
  }
}

function enqueueLookup(request) {
  if (queuePaused) {
    const result = {
      status: "captcha",
      captcha: true,
      error: "Google Maps scraping is paused for human verification."
    };
    notifyTab(request.tabId, request.externalID, result);
    return result;
  }

  const existing = queuedByBuilding.get(request.buildingKey);
  if (existing) {
    addRequestToEntry(existing, request);
    persistPendingQueue().catch(() => {});
    if (existing.started) {
      const result = { status: "scraping" };
      log(`lookup id=${request.externalID} -> cacheHit=false / enqueued pos=active`);
      notifyEntry(existing, result);
      return result;
    }
    const result = {
      status: "queued",
      position: positionForEntry(existing)
    };
    log(`lookup id=${request.externalID} -> cacheHit=false / enqueued pos=${result.position}`);
    notifyQueuedPositions();
    return result;
  }

  const entry = {
    buildingKey: request.buildingKey,
    hit: request.hit,
    requests: [],
    started: false
  };

  addRequestToEntry(entry, request);

  queuedByBuilding.set(request.buildingKey, entry);
  queue.push(entry);
  startKeepaliveIfNeeded();
  persistPendingQueue().catch(() => {});
  const result = {
    status: "queued",
    position: positionForEntry(entry)
  };
  log(`lookup id=${request.externalID} -> cacheHit=false / enqueued pos=${result.position}`);
  notifyQueuedPositions();
  dispatchQueue().catch(() => {});
  return result;
}

function addRequestToEntry(entry, request) {
  entry.requests.push({
    externalID: String(request.externalID || ""),
    tabId: request.tabId || null
  });
}

function positionForEntry(entry) {
  const index = queue.indexOf(entry);
  return index >= 0 ? index + 1 : 0;
}

async function dispatchQueue() {
  if (dispatching) return;
  dispatching = true;

  try {
    while (!queuePaused && queue.length && activeEntries.size < MAX_CONCURRENCY) {
      const entry = queue.shift();
      entry.started = true;
      activeEntries.add(entry);
      startKeepaliveIfNeeded();
      persistPendingQueue().catch(() => {});
      notifyQueuedPositions();

      await sleep(randomInt(JITTER_MIN_MS, JITTER_MAX_MS));
      runEntry(entry).catch(() => {});
    }
  } finally {
    dispatching = false;
    maybeCleanupAfterDrain().catch(() => {});
  }
}

async function runEntry(entry) {
  notifyEntry(entry, { status: "scraping" });

  try {
    const cached = await readCachedResult(entry.buildingKey);
    const result = cached || await scrapeEntry(entry);
    logScrapeResult(entry, result);
    settleEntry(entry, result);
  } catch (error) {
    const result = {
      status: "error",
      error: String(error && error.message ? error.message : error)
    };
    logScrapeResult(entry, result);
    settleEntry(entry, result);
  } finally {
    queuedByBuilding.delete(entry.buildingKey);
    activeEntries.delete(entry);
    persistPendingQueue().catch(() => {});
    if (!queuePaused) {
      dispatchQueue().catch(() => {});
    }
    maybeCleanupAfterDrain().catch(() => {});
  }
}

function settleEntry(entry, result) {
  notifyEntry(entry, result);
}

function notifyEntry(entry, result) {
  uniqueRequests(entry).forEach((request) => {
    notifyTab(request.tabId, request.externalID, result);
  });
}

function uniqueRequests(entry) {
  const seen = new Set();
  return entry.requests.filter((request) => {
    const key = `${request.tabId || ""}:${request.externalID}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function notifyQueuedPositions() {
  queue.forEach((entry, index) => {
    notifyEntry(entry, {
      status: "queued",
      position: index + 1
    });
  });
}

function hitLabel(hit) {
  return hit.building || hit.neighbourhood || hit.title || "unknown";
}

function logScrapeResult(entry, result) {
  const name = hitLabel(entry.hit);
  if (result && result.captcha) {
    log(`DONE building="${name}" captcha (paused)`);
    return;
  }
  if (result && result.noMatch) {
    log(`DONE building="${name}" noMatch`);
    return;
  }
  if (result && result.error) {
    log(`DONE building="${name}" error=${result.error}`);
    return;
  }
  log(`DONE building="${name}" rating=${result && result.rating != null ? result.rating : ""} reviews=${result && result.reviewCount != null ? result.reviewCount : Array.isArray(result && result.reviews) ? result.reviews.length : ""}`);
}

async function injectScraper(tabId) {
  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/maps/scraper.js"]
  });
  return injectionResult && injectionResult.result ? injectionResult.result : null;
}

function stripDebug(result) {
  if (!result || typeof result !== "object") return result;
  const cleanResult = { ...result };
  delete cleanResult.debugHtml;
  return cleanResult;
}

async function scrapeCurrentTab(entry, tabId) {
  const result = await injectScraper(tabId);
  if (!result) throw new Error("Google Maps scraper returned no result.");
  await storeDebugHtml(entry, result);
  return stripDebug(result);
}

async function cacheNoMatch(entry, mapsUrl) {
  const noMatch = {
    status: "noMatch",
    noMatch: true,
    building: hitLabel(entry.hit),
    neighbourhood: entry.hit.neighbourhood || "",
    title: entry.hit.title || "",
    mapsUrl: mapsUrl || "",
    scrapedAt: Date.now()
  };
  await storageSet({
    [buildingCacheKey(entry.buildingKey)]: noMatch
  });
  return noMatch;
}

async function pauseForCaptcha(tabId) {
  queuePaused = true;
  captchaTabId = tabId;
  startCaptchaWatcher();
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

function startCaptchaWatcher() {
  if (captchaWatchTimer) return;
  captchaWatchTimer = setInterval(() => {
    recheckCaptchaTab().catch(() => {});
  }, CAPTCHA_RECHECK_INTERVAL_MS);
}

function stopCaptchaWatcher() {
  if (captchaWatchTimer) {
    clearInterval(captchaWatchTimer);
    captchaWatchTimer = null;
  }
}

async function recheckCaptchaTab() {
  if (!queuePaused || !captchaTabId || captchaWatchRunning) return;
  captchaWatchRunning = true;
  try {
    const result = await injectScraper(captchaTabId);
    if (result && !result.captcha) {
      await resumeQueue();
    }
  } catch (_error) {
    // Keep the queue paused; the user can still resume manually from the popup.
  } finally {
    captchaWatchRunning = false;
  }
}

async function resumeQueue() {
  await initPromise;
  queuePaused = false;
  stopCaptchaWatcher();
  const tabId = captchaTabId;
  captchaTabId = null;

  if (tabId) {
    await chrome.tabs.update(tabId, { url: "about:blank", active: false }).catch(() => {});
    releasePoolTab(tabId);
  }

  persistPendingQueue().catch(() => {});
  dispatchQueue().catch(() => {});
  return getStatusSnapshot();
}

function isFiniteGeo(geo) {
  return Boolean(geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng)));
}

function haversineMeters(a, b) {
  if (!isFiniteGeo(a) || !isFiniteGeo(b)) return Number.POSITIVE_INFINITY;
  const toRadians = (degrees) => Number(degrees) * Math.PI / 180;
  const radiusM = 6371000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(Number(b.lat) - Number(a.lat));
  const deltaLng = toRadians(Number(b.lng) - Number(a.lng));
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return radiusM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nameTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function nameOverlapScore(building, candidateName) {
  const buildingTokens = nameTokens(building);
  if (!buildingTokens.length) return 0;
  const candidateTokens = new Set(nameTokens(candidateName));
  const matched = buildingTokens.filter((token) => candidateTokens.has(token)).length;
  return matched / buildingTokens.length;
}

function chooseResultsListCandidate(entry, resultsList) {
  const candidates = Array.isArray(resultsList) ? resultsList : [];
  const target = entry.hit.geography;
  const withCoords = candidates
    .filter((candidate) => isFiniteGeo(candidate))
    .map((candidate) => ({
      candidate,
      distanceM: haversineMeters(target, candidate)
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  if (withCoords.length) {
    const nearest = withCoords[0];
    return {
      ...nearest,
      accepted: nearest.distanceM <= RESULTS_LIST_ACCEPT_M,
      method: "distance"
    };
  }

  const scored = candidates
    .map((candidate) => ({
      candidate,
      distanceM: null,
      score: nameOverlapScore(entry.hit.building || hitLabel(entry.hit), candidate.name)
    }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;

  return {
    ...scored[0],
    accepted: scored[0].score >= 0.5,
    method: "name"
  };
}

async function resolveResultsList(entry, tabId, result) {
  const choice = chooseResultsListCandidate(entry, result.resultsList);
  if (!choice || !choice.accepted || !choice.candidate || !choice.candidate.href) {
    log(`no acceptable result for "${hitLabel(entry.hit)}" -> noMatch`);
    return cacheNoMatch(entry, result.mapsUrl || "");
  }

  const distanceText = choice.distanceM == null ? `score=${choice.score.toFixed(2)}` : `${Math.round(choice.distanceM)}m`;
  log(`results list for "${hitLabel(entry.hit)}": ${result.resultsList.length} candidates -> chose "${choice.candidate.name || "unknown"}" (${distanceText})`);
  await navigateAndWait(tabId, choice.candidate.href, TAB_LOAD_TIMEOUT_MS);
  log(`opened maps tab ${tabId} url=${choice.candidate.href}`);

  const secondResult = await scrapeCurrentTab(entry, tabId);
  if (secondResult.captcha) return secondResult;
  if (secondResult.resultsList || secondResult.noMatch || !secondResult.placeId) {
    log(`no acceptable result for "${hitLabel(entry.hit)}" -> noMatch`);
    return cacheNoMatch(entry, secondResult.mapsUrl || choice.candidate.href);
  }
  return secondResult;
}

async function scrapeEntry(entry) {
  const queryUrl = buildMapsSearchUrl(entry.hit);
  log(`SCRAPING building="${hitLabel(entry.hit)}" @${entry.hit.geography.lat},${entry.hit.geography.lng} -> opening tab`);
  const poolTab = await acquirePoolTab(entry);
  const tabId = poolTab.id;
  log(`pool: reusing tab ${tabId} for building "${hitLabel(entry.hit)}"`);

  let keepTabBusy = false;
  try {
    await navigateAndWait(tabId, queryUrl, TAB_LOAD_TIMEOUT_MS);
    log(`opened maps tab ${tabId} url=${queryUrl}`);
    let cleanResult = await scrapeCurrentTab(entry, tabId);

    if (cleanResult.captcha) {
      await pauseForCaptcha(tabId);
      keepTabBusy = true;
      return {
        status: "captcha",
        captcha: true,
        error: "Google Maps showed a human-verification challenge. Queue paused."
      };
    }

    if (cleanResult.resultsList) {
      cleanResult = await resolveResultsList(entry, tabId, cleanResult);
      if (cleanResult.captcha) {
        await pauseForCaptcha(tabId);
        keepTabBusy = true;
        return {
          status: "captcha",
          captcha: true,
          error: "Google Maps showed a human-verification challenge. Queue paused."
        };
      }
      if (cleanResult.noMatch) return cleanResult;
    }

    if (cleanResult.noMatch || !cleanResult.placeId) {
      return cacheNoMatch(entry, cleanResult.mapsUrl || "");
    }

    if (isFiniteGeo(cleanResult.placeGeo)) {
      const distanceM = haversineMeters(entry.hit.geography, cleanResult.placeGeo);
      if (distanceM > FINAL_PLACE_ACCEPT_M) {
        log(`rejected far place (${Math.round(distanceM)}m) for "${hitLabel(entry.hit)}"`);
        return cacheNoMatch(entry, cleanResult.mapsUrl || "");
      }
    }

    const placeEntry = {
      status: "done",
      placeId: cleanResult.placeId,
      building: hitLabel(entry.hit),
      neighbourhood: entry.hit.neighbourhood || "",
      title: entry.hit.title || "",
      rating: finiteNumberOrNull(cleanResult.rating),
      reviewCount: finiteNumberOrNull(cleanResult.reviewCount),
      distribution: cleanResult.distribution && typeof cleanResult.distribution === "object" ? cleanResult.distribution : null,
      reviews: Array.isArray(cleanResult.reviews) ? cleanResult.reviews.slice(0, 40) : [],
      placeGeo: isFiniteGeo(cleanResult.placeGeo) ? {
        lat: Number(cleanResult.placeGeo.lat),
        lng: Number(cleanResult.placeGeo.lng)
      } : null,
      mapsUrl: cleanResult.mapsUrl || "",
      scrapedAt: Date.now()
    };

    await storageSet({
      [buildingCacheKey(entry.buildingKey)]: {
        placeId: placeEntry.placeId,
        building: placeEntry.building,
        neighbourhood: placeEntry.neighbourhood,
        title: placeEntry.title,
        updatedAt: Date.now()
      },
      [placeCacheKey(placeEntry.placeId)]: placeEntry
    });

    sessionDoneCount += 1;
    return placeEntry;
  } finally {
    if (!keepTabBusy) {
      releasePoolTab(tabId);
    }
  }
}

async function acquirePoolTab(entry) {
  const free = poolTabs.find((tab) => !tab.busy && !tab.closed);
  if (free) {
    free.busy = true;
    return free;
  }

  if (poolTabs.filter((tab) => !tab.closed).length < MAX_CONCURRENCY) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    const poolTab = { id: tab.id, busy: true, closed: false };
    poolTabs.push(poolTab);
    trackScraperTabs().catch(() => {});
    log(`opened maps tab ${tab.id} url=about:blank`);
    log(`pool: created tab ${tab.id}`);
    return poolTab;
  }

  throw new Error(`No pool tab available for ${hitLabel(entry.hit)}.`);
}

function releasePoolTab(tabId) {
  const poolTab = poolTabs.find((tab) => tab.id === tabId);
  if (poolTab) poolTab.busy = false;
}

async function closePoolTabs(reason) {
  const openTabs = poolTabs.filter((tab) => !tab.closed);
  if (!openTabs.length) return;
  await Promise.all(openTabs.map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
  openTabs.forEach((tab) => log(`closed maps tab ${tab.id}`));
  openTabs.forEach((tab) => {
    tab.closed = true;
    tab.busy = false;
  });
  trackScraperTabs().catch(() => {});
  if (reason === "drain") {
    log(`pool: closed ${openTabs.length} tabs (queue drained)`);
  }
}

async function maybeCleanupAfterDrain() {
  if (queue.length || activeEntries.size || dispatching || queuePaused) return;
  await closePoolTabs("drain");
  stopKeepaliveIfIdle();
}

function buildMapsSearchUrl(hit) {
  const placeName = hit.building || hit.neighbourhood || hit.title || "building";
  const area = hit.neighbourhood && hit.neighbourhood !== placeName ? ` ${hit.neighbourhood}` : "";
  const query = `${placeName}${area} dubai`.replace(/\s+/g, " ").trim();
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${hit.geography.lat},${hit.geography.lng},17z`;
}

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function notifyTab(tabId, externalID, result) {
  if (!tabId || !externalID) return;
  chrome.tabs.sendMessage(tabId, {
    type: "RATING_RESULT",
    externalID: String(externalID),
    result
  }).catch(() => {});
}

function persistableEntry(entry) {
  return {
    buildingKey: entry.buildingKey,
    hit: entry.hit,
    started: Boolean(entry.started),
    requests: uniqueRequests(entry).map((request) => ({
      externalID: request.externalID,
      tabId: request.tabId
    }))
  };
}

async function persistPendingQueue() {
  const entries = [];
  activeEntries.forEach((entry) => entries.push(persistableEntry(entry)));
  queue.forEach((entry) => entries.push(persistableEntry(entry)));
  await storageSet({ [PENDING_QUEUE_KEY]: entries });
}

async function restorePendingQueue() {
  if (dispatching || activeEntries.size || queuePaused) return;

  const stored = (await storageGet(PENDING_QUEUE_KEY))[PENDING_QUEUE_KEY];
  if (!Array.isArray(stored) || !stored.length) {
    stopKeepaliveIfIdle();
    return;
  }

  stored.forEach((storedEntry) => {
    if (!storedEntry || queuedByBuilding.has(storedEntry.buildingKey)) return;
    const hit = normalizeHit(storedEntry.hit);
    if (!hit) return;

    const entry = {
      buildingKey: storedEntry.buildingKey,
      hit,
      requests: [],
      started: false
    };
    (Array.isArray(storedEntry.requests) ? storedEntry.requests : []).forEach((request) => {
      addRequestToEntry(entry, {
        externalID: request.externalID,
        tabId: request.tabId
      });
    });
    if (entry.requests.length) {
      queuedByBuilding.set(entry.buildingKey, entry);
      queue.push(entry);
    }
  });

  if (queue.length) {
    startKeepaliveIfNeeded();
    notifyQueuedPositions();
    dispatchQueue().catch(() => {});
  }
}

async function trackScraperTabs() {
  const ids = poolTabs.filter((tab) => !tab.closed).map((tab) => tab.id);
  await storageSet({ [SCRAPER_TABS_KEY]: ids });
}

async function cleanupOrphanScraperTabs() {
  const stored = (await storageGet(SCRAPER_TABS_KEY))[SCRAPER_TABS_KEY];
  const ids = Array.isArray(stored) ? stored : [];
  const currentIds = new Set(poolTabs.filter((tab) => !tab.closed).map((tab) => tab.id));
  await Promise.all(ids
    .filter((tabId) => !currentIds.has(tabId))
    .map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  await storageSet({ [SCRAPER_TABS_KEY]: [] });
}

function startKeepaliveIfNeeded() {
  if (keepaliveTimer || (!dispatching && !queue.length && !activeEntries.size)) return;
  keepaliveTimer = setInterval(() => {
    log(`keepalive (queue=${queue.length})`);
    chrome.runtime.getPlatformInfo(() => {});
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepaliveIfIdle() {
  if (dispatching || queue.length || activeEntries.size) return;
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    log("queue drained");
  }
}

function navigateAndWait(tabId, url, timeoutMs) {
  if (!chrome.webNavigation || !chrome.webNavigation.onCompleted) {
    return chrome.tabs.update(tabId, { url, active: false })
      .then(() => waitForTabComplete(tabId, timeoutMs));
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timeoutId = setTimeout(() => finish(new Error("Timed out loading Google Maps.")), timeoutMs);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      chrome.webNavigation.onCompleted.removeListener(listener);
      if (error) reject(error);
      else resolve();
    }

    function listener(details) {
      if (details && details.tabId === tabId && details.frameId === 0) {
        finish();
      }
    }

    chrome.webNavigation.onCompleted.addListener(listener);
    chrome.tabs.update(tabId, { url, active: false }).catch(finish);
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeoutId = setTimeout(() => finish(new Error("Timed out loading Google Maps.")), timeoutMs);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch(finish);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
