(async function bayutRatingsMapsScraper() {
  const DEBUG = true;
  const MAX_REVIEWS = 40;
  const MAX_RUNTIME_MS = 26000;
  const WAIT_STEP_MS = 250;
  const LOG_PREFIX = "[BayutRatings][scraper]";
  const startedAt = Date.now();

  function log(message) {
    console.log(`${LOG_PREFIX} ${message}`);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function remainingMs(maxMs) {
    return Math.max(0, Math.min(maxMs, MAX_RUNTIME_MS - (Date.now() - startedAt)));
  }

  function timedOut() {
    return Date.now() - startedAt >= MAX_RUNTIME_MS;
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffc\ufffd]/g, "")
      .replace(/(?:\b(?:Read more|More|Like|Share)\b\s*)+$/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textOf(node) {
    return cleanText(node && node.textContent ? node.textContent : "");
  }

  function ownTextOf(node) {
    if (!node) return "";
    return cleanText(Array.from(node.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent || "")
      .join(" "));
  }

  function isCaptchaPage() {
    const bodyText = textOf(document.body).toLowerCase();
    return Boolean(
      document.querySelector('iframe[src*="recaptcha"], input[name="captcha"], form[action*="sorry"]') ||
      bodyText.includes("unusual traffic") ||
      bodyText.includes("verify you are human") ||
      bodyText.includes("verify you're human") ||
      bodyText.includes("not a robot")
    );
  }

  async function waitFor(predicate, timeoutMs) {
    const limit = remainingMs(timeoutMs);
    const waitStartedAt = Date.now();
    while (Date.now() - waitStartedAt < limit && !timedOut()) {
      if (isCaptchaPage()) return "captcha";
      const result = predicate();
      if (result) return result;
      await sleep(WAIT_STEP_MS);
    }
    return null;
  }

  function visibleElements(selector, root) {
    return Array.from((root || document).querySelectorAll(selector)).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function clickElement(element) {
    if (!element) return false;
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
    return true;
  }

  function extractPlaceIdFromUrl() {
    const url = location.href;
    const gid = url.match(/\/g\/([^/?#]+)/);
    if (gid) return `/g/${decodeURIComponent(gid[1])}`;

    const dataId = url.match(/!1s([^!]+)!/);
    if (dataId) return decodeURIComponent(dataId[1]);

    const cid = url.match(/[?&]cid=(\d+)/);
    if (cid) return `cid:${cid[1]}`;

    return "";
  }

  function parseGeoFromUrl(url) {
    const value = String(url || "");
    const dataMatch = value.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (dataMatch) {
      return {
        lat: Number(dataMatch[1]),
        lng: Number(dataMatch[2])
      };
    }

    const atMatch = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
    if (atMatch) {
      return {
        lat: Number(atMatch[1]),
        lng: Number(atMatch[2])
      };
    }

    return null;
  }

  function parseStrictRatingLabel(label) {
    const trimmed = cleanText(label);
    if (/review/i.test(trimmed)) return null;
    const match = trimmed.match(/^(\d(?:\.\d)?)\s+stars?$/i);
    return match ? Number(match[1]) : null;
  }

  function parseStrictReviewCountLabel(label) {
    const match = cleanText(label).match(/^([\d,]+)\s+reviews?$/i);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }

  function parseDistributionLabel(label) {
    const match = cleanText(label).match(/^([1-5])\s+stars?,\s+([\d,]+)\s+reviews?$/i);
    if (!match) return null;
    return {
      stars: match[1],
      count: Number(match[2].replace(/,/g, ""))
    };
  }

  function parseStars(value) {
    const rating = parseStrictRatingLabel(value);
    if (rating == null) return null;
    const stars = Math.round(rating);
    return stars >= 1 && stars <= 5 ? stars : null;
  }

  function ratingElement() {
    return visibleElements('[role="img"][aria-label*="star" i]')
      .find((element) => parseStrictRatingLabel(element.getAttribute("aria-label")) != null);
  }

  function extractRating() {
    const element = ratingElement();
    return element ? parseStrictRatingLabel(element.getAttribute("aria-label")) : null;
  }

  function placeHeaderContainer() {
    const rating = ratingElement();
    if (!rating) return document.querySelector('[role="main"]') || document.body;

    let node = rating.parentElement;
    while (node && node !== document.body) {
      if (node.querySelector("h1, [role='heading']")) return node;
      const text = textOf(node);
      if (text.length > 0 && text.length < 500 && /\bstars?\b/i.test(text)) return node;
      node = node.parentElement;
    }
    return rating.parentElement || document.body;
  }

  function extractReviewCountFromPage() {
    const strict = visibleElements("[aria-label]")
      .map((element) => parseStrictReviewCountLabel(element.getAttribute("aria-label")))
      .find((value) => value != null);
    if (strict != null) return strict;

    if (!ratingElement()) return null;
    const header = placeHeaderContainer();
    const countElement = Array.from(header.querySelectorAll("span, div, button"))
      .find((element) => /^\((\d[\d,]*)\)$/.test(ownTextOf(element)));
    if (!countElement) return null;

    const match = ownTextOf(countElement).match(/^\((\d[\d,]*)\)$/);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }

  function placeLabel() {
    const heading = visibleElements("h1, [role='heading']").find((element) => textOf(element).length > 1);
    return heading ? textOf(heading) : location.href;
  }

  function hasResultsHeading() {
    return visibleElements("h1, [role='heading']")
      .some((element) => /^results$/i.test(textOf(element)));
  }

  function collectResultsList() {
    const seen = new Set();
    return visibleElements('a[href*="/maps/place/"]').map((link) => {
      const href = new URL(link.getAttribute("href") || "", location.href).href;
      if (seen.has(href)) return null;
      seen.add(href);

      const geo = parseGeoFromUrl(href);
      const result = {
        name: cleanText(link.getAttribute("aria-label") || link.textContent || ""),
        href
      };
      if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
        result.lat = geo.lat;
        result.lng = geo.lng;
      }
      return result;
    }).filter((result) => result && result.href).slice(0, 12);
  }

  function isResultsListPage() {
    if (ratingElement()) return false;
    const candidates = collectResultsList();
    return hasResultsHeading() || candidates.length > 1;
  }

  function panelHtml() {
    if (!DEBUG) return "";
    const feed = document.querySelector('[role="feed"]');
    let panel = feed;
    while (panel && panel !== document.body) {
      if (panel.getAttribute("role") === "main") break;
      const style = getComputedStyle(panel);
      if (panel.scrollHeight > panel.clientHeight + 100 && /(auto|scroll)/.test(style.overflowY)) break;
      panel = panel.parentElement;
    }
    panel = panel || document.querySelector('[role="main"]') || document.body;
    return String(panel.outerHTML || "").slice(0, 250000);
  }

  function withDebug(result) {
    if (DEBUG) result.debugHtml = panelHtml();
    return result;
  }

  function noMatchResult() {
    log("noMatch");
    return withDebug({ noMatch: true, mapsUrl: location.href });
  }

  function captchaResult() {
    log("captcha");
    return withDebug({ captcha: true, mapsUrl: location.href });
  }

  function resultsListResult() {
    const resultsList = collectResultsList();
    log(`resultsList ${resultsList.length}`);
    return withDebug({
      resultsList,
      mapsUrl: location.href
    });
  }

  function extractDistribution() {
    const distribution = {};
    let found = false;
    visibleElements('[role="img"][aria-label*="star" i]').forEach((element) => {
      const parsed = parseDistributionLabel(element.getAttribute("aria-label"));
      if (parsed) {
        found = true;
        distribution[parsed.stars] = parsed.count;
      }
    });

    return found ? distribution : null;
  }

  async function openReviews() {
    const reviewsButton = await waitFor(() => (
      visibleElements('button[aria-label^="Reviews for"], [role="tab"][aria-label^="Reviews for"]')
        .find((element) => /^Reviews for\s+/i.test(element.getAttribute("aria-label") || ""))
    ), 3500);

    if (reviewsButton === "captcha") return "captcha";
    if (!reviewsButton) return false;
    clickElement(reviewsButton);
    return true;
  }

  function sortButtonElement() {
    return visibleElements('button[aria-label*="Sort" i], [role="button"][aria-label*="Sort" i], button, [role="button"]')
      .find((element) => /sort/i.test(`${element.getAttribute("aria-label") || ""} ${textOf(element)}`));
  }

  async function waitForReviewsTabFeed(overviewCardCount) {
    let sortSeen = false;
    const waitStartedAt = Date.now();
    const limit = remainingMs(8000);

    while (Date.now() - waitStartedAt < limit && !timedOut()) {
      if (isCaptchaPage()) return "captcha";
      const hasSort = Boolean(sortButtonElement());
      sortSeen = sortSeen || hasSort;
      const count = reviewCards().length;
      if (hasSort && count > overviewCardCount) return true;
      await sleep(250);
    }

    return sortSeen;
  }

  async function sortNewest() {
    const sortButton = await waitFor(() => sortButtonElement(), 2500);

    if (sortButton === "captcha" || !sortButton) return sortButton;
    clickElement(sortButton);
    await sleep(300);

    const newest = await waitFor(() => (
      visibleElements('[role="menuitem"], [role="option"], button, [role="button"]')
        .find((element) => /newest/i.test(`${element.getAttribute("aria-label") || ""} ${textOf(element)}`))
    ), 2500);

    if (newest === "captcha" || !newest) return newest;
    clickElement(newest);
    await sleep(800);
    return true;
  }

  function reviewCards() {
    return visibleElements("[data-review-id]");
  }

  function expandReviewCard(card) {
    Array.from(card.querySelectorAll("button, [role='button']")).forEach((button) => {
      const labels = [
        button.getAttribute("aria-label") || "",
        textOf(button)
      ].map((label) => label.toLowerCase().trim()).filter(Boolean);

      if (labels.some((label) => label === "more" || label === "see more" || label.includes("see more"))) {
        clickElement(button);
      }
    });
  }

  function findScrollableReviewContainer() {
    const cards = reviewCards();
    for (const card of cards.slice().reverse()) {
      let node = card.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 80 && /(auto|scroll)/.test(style.overflowY)) {
          return node;
        }
        node = node.parentElement;
      }
    }

    const feed = document.querySelector('[role="feed"]');
    if (feed) return feed;

    return visibleElements("div, section")
      .filter((element) => element.scrollHeight > element.clientHeight + 200)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement;
  }

  async function loadReviews(reviewCount, overviewCardCount) {
    const target = Math.min(reviewCount || MAX_REVIEWS, MAX_REVIEWS);
    const container = await waitFor(() => findScrollableReviewContainer(), 2500);
    if (container === "captcha" || !container) return container;

    let lastCount = 0;
    let stableRounds = 0;
    const feedLoadedAt = Date.now();
    const loadStartedAt = Date.now();
    let rounds = 0;

    while (!timedOut() && rounds < 25 && Date.now() - loadStartedAt < 20000) {
      const count = reviewCards().length;
      if (count >= target) break;
      if (count === lastCount) stableRounds += 1;
      else stableRounds = 0;
      if (
        stableRounds >= 3 &&
        count > overviewCardCount &&
        Date.now() - feedLoadedAt >= 4000
      ) {
        break;
      }
      lastCount = count;

      container.scrollTop = container.scrollHeight;
      container.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 1000
      }));

      const cards = reviewCards();
      const lastCard = cards[cards.length - 1];
      if (lastCard && lastCard.scrollIntoView) {
        lastCard.scrollIntoView({ block: "end" });
      }

      rounds += 1;
      await sleep(800);
    }

    reviewCards().forEach(expandReviewCard);
    return true;
  }

  function extractAuthor(card) {
    const photoButton = Array.from(card.querySelectorAll("button[aria-label]"))
      .find((button) => /^Photo of\s+/i.test(button.getAttribute("aria-label") || ""));
    if (photoButton) {
      return cleanText((photoButton.getAttribute("aria-label") || "").replace(/^Photo of\s+/i, ""));
    }

    return cleanText(textOf(card.querySelector(".d4r55")));
  }

  function extractRelativeTime(card) {
    const relativePattern = /^(edited\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
    const exactPattern = /^(yesterday|today)$/i;
    const candidates = Array.from(card.querySelectorAll("span, div"));

    let best = "";
    for (const element of candidates) {
      const ownText = ownTextOf(element);
      if (!ownText || ownText.length > 40) continue;
      if (!relativePattern.test(ownText) && !exactPattern.test(ownText)) continue;
      if (!best || ownText.length < best.length) best = ownText;
    }
    return cleanText(best);
  }

  function extractReviewText(card) {
    expandReviewCard(card);
    const preferred = card.querySelector(".wiI7pd, [class*='wiI7pd']");
    return preferred ? cleanText(preferred.textContent || "") : "";
  }

  function extractReviews() {
    const seen = new Set();
    return reviewCards().slice(0, MAX_REVIEWS).map((card) => {
      const id = card.getAttribute("data-review-id") || "";
      const starElement = card.querySelector('[role="img"][aria-label*="star" i]');
      const review = {
        author: extractAuthor(card),
        stars: starElement ? parseStars(starElement.getAttribute("aria-label")) : null,
        relTime: extractRelativeTime(card),
        text: extractReviewText(card)
      };
      if (!review.text && !review.relTime) return null;

      const key = id || `${review.author}:${review.relTime}:${review.text}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return review;
    }).filter(Boolean);
  }

  const ready = await waitFor(() => document.querySelector("main, [role='main'], [role='application']"), 6000);
  if (ready === "captcha" || isCaptchaPage()) return captchaResult();
  if (!ready) return noMatchResult();

  await sleep(1200);
  const rating = extractRating();
  if (rating == null && isResultsListPage()) return resultsListResult();

  const reviewCountBeforeOpen = extractReviewCountFromPage();
  if (rating == null && reviewCountBeforeOpen == null) {
    return noMatchResult();
  }

  const placeId = extractPlaceIdFromUrl();
  const placeGeo = parseGeoFromUrl(location.href);
  const overviewCardCount = reviewCards().length;
  const opened = await openReviews();
  if (opened === "captcha" || isCaptchaPage()) return captchaResult();

  let reviewsReady = false;
  if (opened && !timedOut()) {
    const readyState = await waitForReviewsTabFeed(overviewCardCount);
    if (readyState === "captcha" || isCaptchaPage()) return captchaResult();
    reviewsReady = Boolean(readyState);
    if (reviewsReady) {
      await sortNewest();
      const loaded = await loadReviews(reviewCountBeforeOpen, overviewCardCount);
      if (loaded === "captcha" || isCaptchaPage()) return captchaResult();
    }
  }

  const reviews = reviewsReady ? extractReviews() : [];
  const distribution = extractDistribution();
  const reviewCount = extractReviewCountFromPage() || reviewCountBeforeOpen;

  log(`place=${placeLabel()} rating=${rating != null ? rating : ""} reviews=${reviewCount != null ? reviewCount : reviews.length}`);
  const result = {
    placeId: placeId || `url:${location.href}`,
    rating,
    reviewCount,
    reviews,
    placeGeo,
    mapsUrl: location.href
  };
  if (distribution) result.distribution = distribution;
  return withDebug(result);
})();
