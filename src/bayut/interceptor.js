(function bayutRatingsInterceptor() {
  const SOURCE = "bayut-ratings";
  const ADS_INDEX_PREFIX = "bayut-production-ads";
  const SEARCH_HOST = "search-dsn.bayut.com";
  const LOG_PREFIX = "[BayutRatings][interceptor]";

  if (window.__bayutRatingsInterceptorInstalled) {
    return;
  }
  window.__bayutRatingsInterceptorInstalled = true;

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  let lastStateHitSignature = "";

  function toUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isBayutSearchUrl(url) {
    return typeof url === "string" && url.includes(SEARCH_HOST) && url.includes("/queries");
  }

  function parseJsonMaybe(value) {
    if (!value || typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function requestIndexesFromBody(body) {
    const parsed = parseJsonMaybe(body);
    if (!parsed || !Array.isArray(parsed.requests)) return [];
    return parsed.requests.map((request) => request && request.indexName).filter(Boolean);
  }

  function isAdsIndex(indexName) {
    return typeof indexName === "string" && indexName.startsWith(ADS_INDEX_PREFIX);
  }

  function locationName(hit, types) {
    if (!hit || !Array.isArray(hit.location)) return "";
    const entry = hit.location.find((item) => item && types.includes(item.type) && item.name);
    return entry ? String(entry.name) : "";
  }

  function extractHit(hit) {
    if (!hit || !hit.externalID || !hit.geography) return null;
    const lat = Number(hit.geography.lat);
    const lng = Number(hit.geography.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      externalID: String(hit.externalID),
      geography: { lat, lng },
      building: locationName(hit, ["condo-building", "tower"]),
      neighbourhood: locationName(hit, ["neighbourhood"]),
      title: hit.title ? String(hit.title) : ""
    };
  }

  function extractHits(payload, requestIndexes) {
    const hits = [];
    const results = Array.isArray(payload && payload.results)
      ? payload.results
      : payload && Array.isArray(payload.hits)
        ? [payload]
        : [];

    results.forEach((result, index) => {
      const indexName = result && (result.index || result.indexName || requestIndexes[index]);
      if (indexName && !isAdsIndex(indexName)) return;
      if (!Array.isArray(result && result.hits)) return;

      result.hits.forEach((hit) => {
        const extracted = extractHit(hit);
        if (extracted) hits.push(extracted);
      });
    });

    return hits;
  }

  function log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  function postHits(hits, sourceType) {
    if (!hits.length) return;
    if (sourceType === "state") {
      log(`window.state hits: ${hits.length}`);
    } else if (sourceType === "intercept") {
      log(`intercepted ads query: ${hits.length} hits`);
    }
    window.postMessage(
      {
        source: SOURCE,
        type: "ALGOLIA_HITS",
        hits
      },
      window.location.origin
    );
  }

  function stateContentPayload() {
    return window.state &&
      window.state.algolia &&
      window.state.algolia.content
      ? window.state.algolia.content
      : null;
  }

  function extractStateHits() {
    const content = stateContentPayload();
    if (!content) return [];

    if (Array.isArray(content.hits) && content.hits.length) {
      return extractHits({ hits: content.hits }, [ADS_INDEX_PREFIX]);
    }

    if (Array.isArray(content.results) && content.results.length) {
      return extractHits({ results: content.results }, content.results.map(() => ADS_INDEX_PREFIX));
    }

    return [];
  }

  function stateHitSignature(hits) {
    return hits.map((hit) => hit.externalID).sort().join("|");
  }

  function inspectWindowState() {
    try {
      const hits = extractStateHits();
      if (!hits.length) return false;
      const signature = stateHitSignature(hits);
      if (!signature || signature === lastStateHitSignature) return true;
      lastStateHitSignature = signature;
      postHits(hits, "state");
      return true;
    } catch (_error) {
      return false;
    }
  }

  function startWindowStatePolling() {
    let checks = 0;
    const maxChecks = Math.ceil(20000 / 400);
    const timer = setInterval(() => {
      checks += 1;
      inspectWindowState();
      if (checks >= maxChecks) clearInterval(timer);
    }, 400);

    window.addEventListener("load", inspectWindowState, { once: true });
  }

  async function inspectFetchResponse(response, requestIndexes) {
    try {
      const clone = response.clone();
      const payload = await clone.json();
      postHits(extractHits(payload, requestIndexes), "intercept");
    } catch (_error) {
      // Ignore non-JSON or opaque responses. Bayut's page request should continue unchanged.
    }
  }

  window.fetch = function patchedFetch(input, init) {
    const url = toUrl(input);
    const shouldInspect = isBayutSearchUrl(url);
    const requestIndexes = shouldInspect
      ? requestIndexesFromBody(init && typeof init.body === "string" ? init.body : "")
      : [];

    return originalFetch.apply(this, arguments).then((response) => {
      if (shouldInspect) {
        inspectFetchResponse(response, requestIndexes);
      }
      return response;
    });
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__bayutRatingsUrl = toUrl(url);
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const url = this.__bayutRatingsUrl || "";
    if (isBayutSearchUrl(url)) {
      const requestIndexes = requestIndexesFromBody(typeof body === "string" ? body : "");
      this.addEventListener("load", function onLoad() {
        try {
          const payload = parseJsonMaybe(this.responseText);
          if (payload) postHits(extractHits(payload, requestIndexes), "intercept");
        } catch (_error) {
          // Keep the host page isolated from extension parsing failures.
        }
      });
    }

    return originalXhrSend.apply(this, arguments);
  };

  startWindowStatePolling();
})();
