(function bayutRatingsContent() {
  const SOURCE = "bayut-ratings";
  const PANEL_ATTR = "data-bayut-ratings-panel";
  const DETAILS_RE = /\/property\/details-(\d+)\.html/;
  const LISTING_CARD_SELECTOR = 'li[aria-label="Listing"]';
  const LISTING_LINK_SELECTOR = 'a[aria-label="Listing link"]';
  const LOCATION_SELECTOR = '[aria-label="Location"]';
  const GALLERY_SELECTOR = '[aria-label="Gallery Container"], [aria-label="Cover Photo"], img[aria-label="Listing photo"]';
  const MAP_ARTICLE_SELECTOR = 'article[aria-label="Listing card"]';
  const PENDING_TIMEOUT_MS = 120000;
  const RECHECK_INTERVAL_MS = 10000;
  const MONITOR_INTERVAL_MS = 5000;
  const VIEWPORT_UPDATE_DEBOUNCE_MS = 250;
  const LOG_PREFIX = "[BayutRatings][content]";

  const hitsByExternalId = new Map();
  const resultsByExternalId = new Map();
  const observedCards = new WeakSet();
  const requestedCards = new WeakSet();
  const requestedExternalIds = new Set();
  const pendingStartedAt = new Map();
  const lastRecheckAt = new Map();
  const noHitLoggedExternalIds = new Set();
  const visibleExternalIDs = new Set();
  let panelCssPromise = null;
  let mutationTarget = null;
  let popoverPortalPromise = null;
  let activePopover = null;
  let focusedExternalID = null;
  let viewportUpdateTimer = 0;

  function log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  function getPanelCss() {
    if (!panelCssPromise) {
      panelCssPromise = fetch(chrome.runtime.getURL("src/bayut/panel.css"))
        .then((response) => response.text())
        .catch(() => "");
    }
    return panelCssPromise;
  }

  function mapsIconLink(mapsUrl, className) {
    if (!mapsUrl) return "";
    return `
      <a class="${className || "br-maps-icon"}" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps" title="Open in Google Maps">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"></path>
        </svg>
      </a>
    `;
  }

  async function getPopoverPortal() {
    if (!popoverPortalPromise) {
      popoverPortalPromise = getPanelCss().then((css) => {
        let host = document.getElementById("bayut-ratings-popover-portal");
        if (!host) {
          host = document.createElement("div");
          host.id = "bayut-ratings-popover-portal";
          host.style.position = "fixed";
          host.style.inset = "0";
          host.style.zIndex = "2147483000";
          host.style.pointerEvents = "none";
          document.body.appendChild(host);
        }

        const root = host.shadowRoot || host.attachShadow({ mode: "open" });
        root.innerHTML = `<style>${css}</style><section class="br-wrap br-open br-portal-wrap" aria-label="Google Maps review popover"></section>`;
        return {
          host,
          root,
          wrap: root.querySelector(".br-portal-wrap")
        };
      });
    }
    return popoverPortalPromise;
  }

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

  function externalIdFromHref(href) {
    const match = String(href || "").match(DETAILS_RE);
    return match ? match[1] : "";
  }

  function externalIdFromCard(card) {
    const anchor = card && card.querySelector && card.querySelector(LISTING_LINK_SELECTOR);
    return anchor ? externalIdFromHref(anchor.getAttribute("href") || anchor.href) : "";
  }

  function allListingCards() {
    return Array.from(document.querySelectorAll(LISTING_CARD_SELECTOR))
      .filter((card) => Boolean(externalIdFromCard(card)));
  }

  function isMapView() {
    const params = new URLSearchParams(location.search);
    return params.get("map_active") === "true" || params.get("commute_active") === "true";
  }

  function transformed(element) {
    if (!element) return false;
    const transform = getComputedStyle(element).transform;
    return Boolean(transform && transform !== "none");
  }

  function hasTransformedAncestor(element, stopElement) {
    let node = element && element.parentElement;
    while (node && node !== document.body) {
      if (transformed(node)) return true;
      if (node === stopElement) break;
      node = node.parentElement;
    }
    return false;
  }

  function findMapOverlayTarget(card) {
    const image = card.querySelector(GALLERY_SELECTOR);
    if (!image) return null;

    const article = image.closest(MAP_ARTICLE_SELECTOR);
    if (
      article &&
      !transformed(article) &&
      !article.closest(LISTING_LINK_SELECTOR) &&
      !hasTransformedAncestor(article, card)
    ) {
      return {
        image,
        parent: article
      };
    }

    let node = image.parentElement;
    while (node && node !== document.body) {
      if (
        !transformed(node) &&
        !hasTransformedAncestor(node, card) &&
        !node.closest(LISTING_LINK_SELECTOR)
      ) {
        return {
          image,
          parent: node
        };
      }
      if (node === card) break;
      node = node.parentElement;
    }

    return null;
  }

  function panelHostForCard(card, externalID) {
    const location = card.querySelector(LOCATION_SELECTOR);
    const mapTarget = isMapView() ? findMapOverlayTarget(card) : null;
    const parent = mapTarget && mapTarget.parent
      ? mapTarget.parent
      : location && location.parentElement
        ? location.parentElement
        : card.querySelector(MAP_ARTICLE_SELECTOR) || card;
    const host = card.querySelector(`[${PANEL_ATTR}="${CSS.escape(externalID)}"]`);
    return {
      location,
      mode: mapTarget ? "map" : "list",
      image: mapTarget ? mapTarget.image : null,
      parent,
      host
    };
  }

  function findResultsContainer(cards) {
    const firstCard = cards[0];
    if (!firstCard) return document.documentElement;

    let node = firstCard.parentElement;
    while (node && node !== document.body) {
      if (node.querySelectorAll && node.querySelectorAll(LISTING_CARD_SELECTOR).length >= Math.min(cards.length, 2)) {
        return node;
      }
      node = node.parentElement;
    }
    return firstCard.parentElement || document.documentElement;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function filledStarCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(5, Math.round(number)));
  }

  function starRow(value, label, className) {
    const filled = filledStarCount(value);
    const stars = Array.from({ length: 5 }, (_unused, index) => (
      `<span class="${index < filled ? "br-star-filled" : "br-star-empty"}">★</span>`
    )).join("");
    return `<span class="${className || "br-stars"}" aria-label="${escapeHtml(label || `${filled} out of 5 stars`)}">${stars}</span>`;
  }

  function numericDistribution(distribution) {
    if (!distribution || typeof distribution !== "object") return null;
    const values = {};
    let hasAny = false;
    ["5", "4", "3", "2", "1"].forEach((star) => {
      if (Object.prototype.hasOwnProperty.call(distribution, star)) hasAny = true;
      const value = Number(distribution[star] || 0);
      values[star] = Number.isFinite(value) && value > 0 ? value : 0;
    });
    return hasAny ? values : null;
  }

  function distributionHtml(distribution) {
    const values = numericDistribution(distribution);
    if (!values) return "";
    const maxCount = Math.max(...Object.values(values), 1);
    return `
      <div class="br-distribution" aria-label="Rating distribution">
        ${["5", "4", "3", "2", "1"].map((star) => {
          const count = values[star];
          const width = Math.round((count / maxCount) * 100);
          return `
            <div class="br-dist-row">
              <span class="br-dist-label">${star}</span>
              <span class="br-dist-track"><span class="br-dist-fill" style="width: ${width}%"></span></span>
              <span class="br-dist-count">${count.toLocaleString()}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function sortedReviews(reviews, sortMode) {
    const indexed = reviews.map((review, index) => ({ review, index }));
    if (sortMode === "highest" || sortMode === "lowest") {
      indexed.sort((a, b) => {
        const aStars = Number(a.review.stars);
        const bStars = Number(b.review.stars);
        const aMissing = a.review.stars == null || !Number.isFinite(aStars);
        const bMissing = b.review.stars == null || !Number.isFinite(bStars);
        if (aMissing && bMissing) return a.index - b.index;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (aStars === bStars) return a.index - b.index;
        return sortMode === "highest" ? bStars - aStars : aStars - bStars;
      });
    }
    return indexed.map((entry) => entry.review);
  }

  function reviewRowsHtml(reviews, sortMode) {
    const rows = sortedReviews(reviews, sortMode).filter((review) => review && (review.text || review.relTime));
    if (!rows.length) return `<div class="br-state">No review snippets loaded.</div>`;
    return rows.map((review) => `
      <div class="br-review">
        <div class="br-review-meta">
          <span class="br-author">${escapeHtml(review.author || "Google Maps reviewer")}</span>
          ${review.stars != null && Number.isFinite(Number(review.stars)) ? starRow(Number(review.stars), `${review.stars} out of 5 stars`, "br-review-stars") : ""}
          ${review.relTime ? `<span class="br-review-time">${escapeHtml(review.relTime)}</span>` : ""}
        </div>
        ${review.text ? `<p>${escapeHtml(review.text || "")}</p>` : ""}
      </div>
    `).join("");
  }

  function resultState(result) {
    if (result && result.status === "queued") {
      return result.position ? `Queued (${ordinal(result.position)})` : "Queued";
    }
    if (result && result.status === "scraping") return "Fetching Maps reviews...";
    if (!result) return "Fetching Maps reviews...";
    if (result.captcha) return "Verify on Maps (paused)";
    if (result.noMatch) return "No Maps match";
    if (result.status === "timeout") return "Reviews unavailable - click to retry";
    if (result.error) return result.retryable ? "Maps reviews unavailable - click to retry" : "Maps reviews unavailable";
    return "";
  }

  function badgeKind(result) {
    if (!result) return "loading";
    if (result.status === "queued") return "queued";
    if (result.status === "scraping") return "loading";
    if (result.status === "deferred") return "idle";
    if (result.status === "timeout") return "timeout";
    if (result.captcha) return "captcha";
    if (result.noMatch) return "no-match";
    if (result.error) return "error";
    return "loaded";
  }

  function ordinal(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const suffix = number % 100 >= 11 && number % 100 <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th");
    return `${number}${suffix}`;
  }

  function isPendingResult(result) {
    return Boolean(result && (result.status === "queued" || result.status === "scraping"));
  }

  function isTerminalResult(result) {
    return Boolean(result && (
      result.status === "done" ||
      result.status === "noMatch" ||
      result.status === "timeout" ||
      result.status === "deferred" ||
      result.captcha ||
      result.noMatch ||
      result.error
    ));
  }

  function isRetryableResult(result) {
    return Boolean(result && (result.status === "timeout" || result.retryable || result.error));
  }

  function resultSignature(result) {
    if (!result) return "";
    return [
      result.status || "",
      result.placeId || "",
      result.placeName || "",
      result.rating == null ? "" : String(result.rating),
      result.reviewCount == null ? "" : String(result.reviewCount),
      Array.isArray(result.reviews) ? String(result.reviews.length) : ""
    ].join("|");
  }

  function equivalentResult(a, b) {
    return resultSignature(a) === resultSignature(b);
  }

  function applyResult(externalID, result) {
    if (!externalID || !result) return;
    const normalized = normalizeResult(result);
    const previous = resultsByExternalId.get(String(externalID));
    const equivalent = equivalentResult(previous, normalized);
    resultsByExternalId.set(String(externalID), normalized);
    logResult(String(externalID), normalized);

    if (normalized && normalized.status === "deferred") {
      clearRequestGuards(String(externalID));
    }

    if (isPendingResult(normalized)) {
      if (!pendingStartedAt.has(String(externalID))) {
        pendingStartedAt.set(String(externalID), Date.now());
      }
    } else if (isTerminalResult(normalized)) {
      pendingStartedAt.delete(String(externalID));
      lastRecheckAt.delete(String(externalID));
    }

    if (!equivalent) {
      renderResultEverywhere(String(externalID), normalized);
    }
  }

  function logResult(externalID, result) {
    const status = result.status || (result.noMatch ? "noMatch" : result.captcha ? "captcha" : result.error ? "error" : "done");
    const rating = result.rating != null ? result.rating : "";
    const reviews = Array.isArray(result.reviews)
      ? result.reviews.length
      : result.reviewCount != null
        ? result.reviewCount
        : "";
    log(`result id=${externalID} status=${status} rating=${rating} reviews=${reviews}`);
  }

  function normalizeResult(result) {
    if (!result || typeof result !== "object") return result;
    if (result.status) return result;
    if (result.noMatch) return { ...result, status: "noMatch" };
    if (result.captcha) return { ...result, status: "captcha" };
    if (result.error) return { ...result, status: "error", retryable: true };
    if (result.rating != null || result.placeId || result.reviews) return { ...result, status: "done" };
    return result;
  }

  function clearRequestGuards(externalID) {
    requestedExternalIds.delete(externalID);
    pendingStartedAt.delete(externalID);
    lastRecheckAt.delete(externalID);
    allListingCards().forEach((card) => {
      if (externalIdFromCard(card) === externalID) requestedCards.delete(card);
    });
  }

  function resetHostPosition(host) {
    host.style.position = "";
    host.style.left = "";
    host.style.top = "";
    host.style.zIndex = "";
    host.style.margin = "";
    host.style.maxWidth = "";
    host.style.pointerEvents = "";
  }

  function positionMapHost(target, host) {
    if (!target.image || !target.parent) return;
    if (getComputedStyle(target.parent).position === "static") {
      target.parent.style.position = "relative";
    }

    const parentRect = target.parent.getBoundingClientRect();
    const imageRect = target.image.getBoundingClientRect();
    const inset = 8;
    const hostHeight = host.offsetHeight || 28;
    const imageTop = imageRect.top - parentRect.top;
    const imageBottom = imageRect.bottom - parentRect.top;
    const left = Math.max(inset, imageRect.left - parentRect.left + inset);
    const top = Math.max(imageTop + inset, imageBottom - hostHeight - inset);

    host.style.position = "absolute";
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
    host.style.zIndex = "5";
    host.style.margin = "0";
    host.style.maxWidth = `${Math.max(120, Math.round(imageRect.width - inset * 2))}px`;
    host.style.pointerEvents = "auto";
  }

  function insertPanelHost(target, host) {
    host.dataset.bayutRatingsMode = target.mode;
    if (target.mode === "map" && target.parent) {
      if (host.parentElement !== target.parent) {
        target.parent.appendChild(host);
      }
      return;
    }

    resetHostPosition(host);
    if (target.location && target.location.parentElement) {
      const referenceNode = target.location.nextSibling;
      if (referenceNode !== host) {
        target.location.parentElement.insertBefore(host, referenceNode);
      }
      return;
    }
    if (host.parentElement !== target.parent || host.parentElement.lastElementChild !== host) {
      target.parent.appendChild(host);
    }
  }

  function popoverHtml(result, reviews, sortMode) {
    const rating = result && result.rating != null && Number.isFinite(Number(result.rating)) ? Number(result.rating).toFixed(1) : "";
    const reviewCount = result && result.reviewCount != null && Number.isFinite(Number(result.reviewCount)) ? Number(result.reviewCount).toLocaleString() : "";
    const mapsUrl = result && result.mapsUrl ? result.mapsUrl : "";
    const placeName = result && typeof result.placeName === "string" ? result.placeName.trim() : "";
    const showPlaceName = placeName && !/^https?:\/\//i.test(placeName);
    const summaryStars = rating ? starRow(Number(rating), `${rating} out of 5 stars`, "br-summary-stars") : "";
    const distribution = distributionHtml(result && result.distribution);
    const reviewsHtml = reviewRowsHtml(reviews, sortMode || "newest");

    return `
      <div class="br-popover" role="dialog" aria-label="Google Maps review snippets">
        <div class="br-summary-head">
          <div class="br-summary-rating">${escapeHtml(rating || "-")}</div>
          <div class="br-summary-copy">
            ${summaryStars}
            <div class="br-summary-count">${escapeHtml(reviewCount ? `${reviewCount} reviews` : "Google Maps reviews")}</div>
            ${showPlaceName ? `<div class="br-place-name">${escapeHtml(placeName)}</div>` : ""}
          </div>
          ${mapsIconLink(mapsUrl, "br-popover-link br-maps-icon")}
        </div>
        ${distribution}
        <div class="br-sort" role="group" aria-label="Sort reviews">
          <button type="button" class="br-sort-button${sortMode === "newest" || !sortMode ? " br-sort-active" : ""}" data-sort="newest" aria-pressed="${sortMode === "newest" || !sortMode ? "true" : "false"}">Newest</button>
          <button type="button" class="br-sort-button${sortMode === "highest" ? " br-sort-active" : ""}" data-sort="highest" aria-pressed="${sortMode === "highest" ? "true" : "false"}">Highest</button>
          <button type="button" class="br-sort-button${sortMode === "lowest" ? " br-sort-active" : ""}" data-sort="lowest" aria-pressed="${sortMode === "lowest" ? "true" : "false"}">Lowest</button>
        </div>
        <div class="br-reviews">${reviewsHtml}</div>
      </div>
    `;
  }

  function stopCardClick(event) {
    event.stopPropagation();
  }

  async function openPortalPopover(badge, result, reviews) {
    if (activePopover && activePopover.close) {
      activePopover.close();
    }

    const portal = await getPopoverPortal();
    const state = {
      badge,
      portal,
      result,
      reviews,
      sortMode: "newest",
      hideTimer: 0,
      listening: false,
      closed: false
    };

    function render() {
      portal.wrap.innerHTML = popoverHtml(state.result, state.reviews, state.sortMode);
      const popover = portal.root.querySelector(".br-popover");
      popover.addEventListener("mouseenter", keepOpen);
      popover.addEventListener("mouseleave", scheduleHide);
      popover.addEventListener("click", stopCardClick);
      popover.addEventListener("pointerdown", stopCardClick);
      portal.root.querySelectorAll(".br-sort-button").forEach((button) => {
        button.addEventListener("click", (event) => {
          stopCardClick(event);
          state.sortMode = button.dataset.sort || "newest";
          render();
          position();
        });
      });
      portal.root.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", stopCardClick);
        link.addEventListener("pointerdown", stopCardClick);
      });
    }

    function position() {
      const popover = portal.root.querySelector(".br-popover");
      if (!popover || !state.badge || state.closed) return;
      const rect = state.badge.getBoundingClientRect();
      const margin = 10;
      const width = Math.min(360, window.innerWidth - margin * 2);
      popover.style.width = `${width}px`;

      const measuredHeight = Math.min(popover.scrollHeight || 0, 460);
      const openBelow = rect.bottom + margin + measuredHeight <= window.innerHeight || rect.top < measuredHeight + margin;
      const top = openBelow
        ? rect.bottom + 8
        : Math.max(margin, rect.top - measuredHeight - 8);
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - width - margin)
      );

      popover.style.top = `${Math.round(top)}px`;
      popover.style.left = `${Math.round(left)}px`;
    }

    function addWindowListeners() {
      if (state.listening) return;
      state.listening = true;
      window.addEventListener("scroll", position, { passive: true });
      window.addEventListener("resize", position);
    }

    function removeWindowListeners() {
      if (!state.listening) return;
      state.listening = false;
      window.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
    }

    function keepOpen() {
      clearTimeout(state.hideTimer);
    }

    function scheduleHide() {
      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(close, 200);
    }

    function close() {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.hideTimer);
      removeWindowListeners();
      portal.wrap.innerHTML = "";
      activePopover = null;
    }

    state.close = close;
    state.scheduleHide = scheduleHide;
    activePopover = state;
    render();
    addWindowListeners();
    position();
  }

  function schedulePortalHide(badge) {
    if (activePopover && activePopover.scheduleHide && (!badge || activePopover.badge === badge)) {
      activePopover.scheduleHide();
    }
  }

  function attachPopoverHandlers(host, result, reviews, externalID, retryable) {
    if (host.__bayutRatingsCleanup) {
      host.__bayutRatingsCleanup();
      host.__bayutRatingsCleanup = null;
    }

    const root = host.shadowRoot;
    if (!root) return;

    const wrap = root.querySelector(".br-wrap");
    const badge = root.querySelector(".br-badge");
    if (!wrap || !badge) return;

    function show() {
      wrap.classList.add("br-open");
      if (badgeKind(result) === "loaded") {
        openPortalPopover(badge, result, reviews).catch(() => {});
      }
    }

    function scheduleHide() {
      wrap.classList.remove("br-open");
      schedulePortalHide(badge);
    }

    function retryFromBadge(event) {
      if (!retryable) return;
      event.preventDefault();
      event.stopPropagation();
      retryLookup(externalID);
    }

    badge.addEventListener("mouseenter", show);
    badge.addEventListener("mouseleave", scheduleHide);
    badge.addEventListener("click", retryFromBadge);
    badge.addEventListener("click", stopCardClick);
    badge.addEventListener("pointerdown", stopCardClick);
    badge.addEventListener("keydown", (event) => {
      if (retryable && (event.key === "Enter" || event.key === " ")) {
        retryFromBadge(event);
      }
    });
    badge.addEventListener("focus", show);
    badge.addEventListener("blur", scheduleHide);

    host.__bayutRatingsCleanup = function cleanupPopoverHandlers() {
      scheduleHide();
    };
  }

  async function renderPanel(card, externalID, result) {
    const css = await getPanelCss();
    const target = panelHostForCard(card, externalID);
    let host = target.host;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute(PANEL_ATTR, externalID);
      host.dataset.bayutRatingsExternalId = externalID;
      insertPanelHost(target, host);
      host.attachShadow({ mode: "open" });
    } else {
      insertPanelHost(target, host);
    }

    const reviews = Array.isArray(result && result.reviews)
      ? result.reviews.filter((review) => review && (review.text || review.relTime))
      : [];
    const state = resultState(result);
    const kind = badgeKind(result);
    const retryable = isRetryableResult(result);
    const rating = result && result.rating != null && Number.isFinite(Number(result.rating)) ? Number(result.rating).toFixed(1) : "";
    const reviewCount = result && result.reviewCount != null && Number.isFinite(Number(result.reviewCount)) ? Number(result.reviewCount).toLocaleString() : "";
    const mapsUrl = result && result.mapsUrl ? result.mapsUrl : "";
    const summary = rating
      ? `${rating} stars${reviewCount ? `, ${reviewCount} reviews` : ""}`
      : "Google Maps reviews";

    host.shadowRoot.innerHTML = `
      <style>${css}</style>
      <section class="br-wrap br-${escapeHtml(kind)}${retryable ? " br-retryable" : ""}" aria-label="Google Maps rating">
        <div class="br-badge" tabindex="0" ${retryable ? 'role="button"' : ""} aria-label="${escapeHtml(state || summary)}">
          ${kind === "loading" ? `<span class="br-spinner" aria-hidden="true"></span>` : ""}
          ${kind === "loaded" ? `<span class="br-star" aria-hidden="true">★</span>` : ""}
          <span class="br-badge-text">${escapeHtml(state || summary)}</span>
          ${retryable ? `<span class="br-retry-hint">retry</span>` : ""}
          ${kind === "loaded" ? mapsIconLink(mapsUrl, "br-badge-link br-maps-icon") : ""}
        </div>
      </section>
    `;

    attachPopoverHandlers(host, result, reviews, externalID, retryable);
    if (target.mode === "map") {
      window.requestAnimationFrame(() => positionMapHost(target, host));
    }
  }

  function renderResultEverywhere(externalID, result) {
    allListingCards().forEach((card) => {
      if (externalIdFromCard(card) === externalID) {
        renderPanel(card, externalID, result);
      }
    });
  }

  async function requestLookup(card) {
    const externalID = externalIdFromCard(card);
    if (!externalID || requestedCards.has(card)) return;

    const existing = resultsByExternalId.get(externalID);
    if (existing && existing.status !== "deferred") {
      requestedCards.add(card);
      renderPanel(card, externalID, existing);
      return;
    }

    const hit = hitsByExternalId.get(externalID) || null;
    if (!hit) {
      if (!noHitLoggedExternalIds.has(externalID)) {
        noHitLoggedExternalIds.add(externalID);
        log(`card id=${externalID} has no hit yet`);
      }
      await renderPanel(card, externalID, null);
      return;
    }

    requestedCards.add(card);
    log(`lookup requested id=${externalID} building="${hit.building || hit.neighbourhood || ""}"`);
    applyResult(externalID, { status: "scraping" });
    if (requestedExternalIds.has(externalID)) return;
    requestedExternalIds.add(externalID);
    pendingStartedAt.set(externalID, Date.now());

    const response = await sendMessage({
      type: "LOOKUP_LISTING",
      externalID,
      hit
    });

    if (response && response.result) {
      applyResult(externalID, response.result);
    }
  }

  async function resendLookup(externalID) {
    const hit = hitsByExternalId.get(externalID);
    if (!hit) return;

    const response = await sendMessage({
      type: "LOOKUP_LISTING",
      externalID,
      hit
    });

    if (response && response.result) {
      applyResult(externalID, response.result);
    }
  }

  function retryLookup(externalID) {
    requestedExternalIds.delete(externalID);
    pendingStartedAt.delete(externalID);
    lastRecheckAt.delete(externalID);
    applyResult(externalID, { status: "scraping" });
    resendLookup(externalID);
  }

  function sendViewportUpdateNow() {
    sendMessage({
      type: "VIEWPORT_UPDATE",
      visibleExternalIDs: Array.from(visibleExternalIDs),
      focusedExternalID
    });
  }

  function scheduleViewportUpdate() {
    clearTimeout(viewportUpdateTimer);
    viewportUpdateTimer = setTimeout(sendViewportUpdateNow, VIEWPORT_UPDATE_DEBOUNCE_MS);
  }

  function setFocusedExternalID(externalID) {
    const next = externalID ? String(externalID) : null;
    if (focusedExternalID === next) return;
    focusedExternalID = next;
    scheduleViewportUpdate();
  }

  function clearFocusedExternalID(externalID) {
    if (focusedExternalID !== String(externalID || "")) return;
    focusedExternalID = null;
    scheduleViewportUpdate();
  }

  function cardIsVisible(card) {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const externalID = externalIdFromCard(entry.target);
      if (externalID) {
        const wasVisible = visibleExternalIDs.has(externalID);
        if (entry.isIntersecting) {
          visibleExternalIDs.add(externalID);
        } else {
          visibleExternalIDs.delete(externalID);
        }
        if (wasVisible !== visibleExternalIDs.has(externalID)) scheduleViewportUpdate();
      }

      if (entry.isIntersecting) {
        requestLookup(entry.target);
      }
    });
  }, {
    rootMargin: "300px 0px",
    threshold: 0.01
  });

  function isNearViewport(card) {
    const rect = card.getBoundingClientRect();
    const margin = 300;
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  }

  function isExternalIDVisibleOrNearViewport(externalID) {
    if (visibleExternalIDs.has(externalID)) return true;
    return allListingCards().some((card) => externalIdFromCard(card) === externalID && isNearViewport(card));
  }

  function scanListings() {
    const cards = allListingCards();
    observeResultsContainer(cards);
    let visibleChanged = false;

    cards.forEach((card) => {
      const externalID = externalIdFromCard(card);
      if (!observedCards.has(card)) {
        observedCards.add(card);
        observer.observe(card);
        card.addEventListener("mouseenter", () => setFocusedExternalID(externalIdFromCard(card)));
        card.addEventListener("mouseleave", () => clearFocusedExternalID(externalIdFromCard(card)));
        card.addEventListener("focusin", () => setFocusedExternalID(externalIdFromCard(card)));
        card.addEventListener("focusout", () => clearFocusedExternalID(externalIdFromCard(card)));
      }

      if (externalID) {
        const isVisible = cardIsVisible(card);
        const wasVisible = visibleExternalIDs.has(externalID);
        if (isVisible) {
          visibleExternalIDs.add(externalID);
        } else if (!isNearViewport(card)) {
          visibleExternalIDs.delete(externalID);
        }
        if (wasVisible !== visibleExternalIDs.has(externalID)) visibleChanged = true;
      }

      const result = externalID ? resultsByExternalId.get(externalID) : null;
      if (externalID && result && !panelHostForCard(card, externalID).host) {
        renderPanel(card, externalID, result);
      }
      if (externalID && hitsByExternalId.has(externalID) && isNearViewport(card) && !requestedCards.has(card)) {
        requestLookup(card);
      }
    });

    if (visibleChanged) scheduleViewportUpdate();
  }

  function storeHits(hits) {
    hits.forEach((hit) => {
      if (hit && hit.externalID) hitsByExternalId.set(String(hit.externalID), hit);
    });
    log(`stored ${hits.length} hits (total known: ${hitsByExternalId.size})`);

    sendMessage({
      type: "BAYUT_HITS",
      hits
    });

    scanListings();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    if (event.data.type === "ALGOLIA_HITS" && Array.isArray(event.data.hits)) {
      storeHits(event.data.hits);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "RATING_RESULT" || !message.externalID) return;
    applyResult(String(message.externalID), message.result);
  });

  const mutationObserver = new MutationObserver(() => {
    window.requestAnimationFrame(scanListings);
  });

  function observeResultsContainer(cards) {
    const nextTarget = findResultsContainer(cards);
    if (mutationTarget === nextTarget) return;

    mutationObserver.disconnect();
    mutationTarget = nextTarget;
    mutationObserver.observe(mutationTarget, {
      childList: true,
      subtree: true
    });
  }

  function start() {
    scanListings();
    scheduleViewportUpdate();
  }

  setInterval(() => {
    const now = Date.now();
    resultsByExternalId.forEach((result, externalID) => {
      if (!isPendingResult(result)) return;
      if (!isExternalIDVisibleOrNearViewport(externalID)) return;

      const startedAt = pendingStartedAt.get(externalID) || now;
      pendingStartedAt.set(externalID, startedAt);
      if (now - startedAt >= PENDING_TIMEOUT_MS) {
        log(`TIMEOUT id=${externalID} (click to retry)`);
        applyResult(externalID, {
          status: "timeout",
          error: "Lookup timed out.",
          retryable: true
        });
        return;
      }

      const last = lastRecheckAt.get(externalID) || 0;
      if (now - last >= RECHECK_INTERVAL_MS) {
        lastRecheckAt.set(externalID, now);
        resendLookup(externalID);
      }
    });
  }, MONITOR_INTERVAL_MS);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
