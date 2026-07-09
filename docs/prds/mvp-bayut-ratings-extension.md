# Bayut → Google Maps Ratings Chrome Extension (MVP)

## Problem
When apartment hunting on Bayut, the user must manually leave each listing, search Google
Maps for the building, and read reviews (sorted by newest). Goal: a personal-use Chrome
extension (Manifest V3) that automatically shows each building's Google Maps rating and
newest reviews inline on the Bayut listing pages, caching results so scraping happens once
per building.

**Personal use only.** Not for Chrome Web Store. Loaded unpacked in the user's own Chrome
with their logged-in Google session.

## Verified facts (do NOT re-derive — confirmed via live inspection 2026-07-09)

### Bayut data source
- `window.state` is a STALE SSR snapshot — do NOT use it for the visible listings. Its only
  hits array (`state.algolia.content`) holds default results, not the filtered/sorted view.
- The visible listing cards are populated from **Algolia** POST requests to
  `https://search-dsn.bayut.com/1/indexes/*/queries`, index **`bayut-production-ads-en`**.
  (A separate `bayut-production-locations-en` index is location autocomplete — IGNORE it.)
- Each ads hit contains:
  - `geography: {lat, lng}` — ALWAYS present (exact listing coordinates).
  - `location[]`: array of `{name, type}`. Building is the entry with `type` matching
    `condo-building` (sometimes `tower`); neighbourhood has `type: "neighbourhood"`.
    ~1 in 4 listings has NO building entry — fall back to coordinates.
  - `externalID` (string) — unique listing id, matches the card's detail link
    `/property/details-<externalID>.html`.
  - `title`, `price`, `rooms`, `baths`, `area`, `slug`.
- The Algolia endpoint CANNOT be replayed from a background context / curl: it returns
  `401 Www-Authenticate: hb-challenge` (HUMAN Security bot protection). It only succeeds as
  the page's own in-session request. Therefore we MUST intercept the page's own responses.

### Capturing Algolia responses (critical technique)
- A content script's ISOLATED world cannot see page globals or patch the page's `fetch`.
- Inject a script at `document_start` running in `world: "MAIN"` (via `manifest.json`
  content_scripts entry with `"world": "MAIN"`, or `chrome.scripting.registerContentScripts`
  with `world: "MAIN"`). It must run BEFORE Bayut's app scripts, because Algolia's JS client
  captures its own `fetch` reference at init — a late patch catches nothing.
- The MAIN-world script monkeypatches `window.fetch` AND `XMLHttpRequest` (open/send) to
  detect URLs containing `search-dsn.bayut.com`, clone/parse the JSON response, and forward
  hits to the isolated content script via `window.postMessage`. The isolated content script
  relays to the service worker via `chrome.runtime.sendMessage`.
- Extract per hit: `{externalID, geography:{lat,lng}, building, neighbourhood, title}`.

### Google Maps place resolution + review scrape (confirmed working)
- Build a query URL: `https://www.google.com/maps/search/<building> <area> dubai/@<lat>,<lng>,17z`
  (URL-encode the query). If no building name, use `<neighbourhood> dubai` + coords.
  This auto-redirects to the matching place page. Confirmed: "Empower HQ Residential" →
  resolved to place "Empower Residences", 3.9 stars, URL carries a stable Google place ID
  (e.g. `/g/11md2syk75`) and CID.
- On the place page:
  - Rating: element `[role="img"][aria-label*="star"]` → aria-label like "3.9 stars".
  - Open reviews: click the button/tab whose aria-label starts with "Reviews for ".
  - Review cards: `[data-review-id]`. Within each: star via `[role="img"][aria-label*="star"]`,
    review text in `.wiI7pd` (may be truncated behind a "More" button), reviewer name via the
    card's `button[aria-label]`. Confirmed 69 cards for one place.
  - Sort by newest: click the "Sort reviews" button, then choose the "Newest" menu item.
  - Scroll the reviews scroll-container to lazy-load more (virtualized list).
- Maps DOM class names (e.g. `.wiI7pd`) are obfuscated and may change; prefer aria/role/
  data-attribute selectors and degrade gracefully. This is acceptable for a personal tool.

### Unfocused-tab behavior
- Hidden/background tabs keep rendering, scrolling, and running fetch/DOM — only
  `setTimeout`/`setInterval` scheduling is throttled (min ~1/min after a few minutes).
  Make the scraper event/scroll-driven, not long-poll-driven. Open Maps tabs with
  `chrome.tabs.create({ url, active: false })` so focus is never stolen; close when done.

## Solution / Architecture

Four components:

1. **manifest.json (MV3)**
   - `content_scripts`: on `*://*.bayut.com/*` — one entry `world: "MAIN"` at `document_start`
     (the interceptor) and one isolated entry (the relay + panel injector).
   - `host_permissions`: `*://*.bayut.com/*`, `*://*.google.com/*`.
   - `permissions`: `storage`, `tabs`, `scripting`.
   - `background.service_worker`.

2. **MAIN-world interceptor** (`src/bayut/interceptor.js`)
   - Patches fetch + XHR, captures `search-dsn.bayut.com` `bayut-production-ads-en` responses,
     posts extracted hits via `window.postMessage({source:"bayut-ratings", hits:[...]})`.

3. **Service worker** (`src/background/worker.js`)
   - Receives hits; dedups to unique buildings (key: building name + rounded coords, and once
     resolved, the Google place ID).
   - Cache in `chrome.storage.local`, two-level:
     `buildingKey -> placeId` and `placeId -> {rating, reviewCount, reviews:[{author,stars,text,relTime}], scrapedAt}`.
     TTL configurable (default 14 days). Cache hit ⇒ no Maps traffic.
   - SERIAL queue, ONE hidden Maps tab at a time, randomized 3–8s jitter between lookups.
   - For each building: open hidden Maps tab, inject/execute the Maps scraper, get data,
     close tab, write cache, push result to the originating Bayut tab.
   - CAPTCHA detection: if the Maps tab shows a "verify you're human" challenge, PAUSE the
     queue (do not hammer) and optionally surface the tab (make it active) for the user to solve.

4. **Bayut content script (isolated)** (`src/bayut/content.js`)
   - Relays MAIN-world postMessages to the worker.
   - Lazy: use IntersectionObserver on listing cards; only request a lookup when a card scrolls
     into view. Match a card to a hit by `externalID` (from the detail href
     `/property/details-<id>.html`).
   - When cached/scraped data arrives, inject a compact panel under the matching card showing:
     **star rating + review count + the 3–5 newest review snippets (author, stars, relative
     time, truncated text)**, plus a link to open the full Maps place in a new tab.
   - Panel must be styled in an isolated way (no leaking Bayut styles; use a shadow DOM or a
     scoped class prefix). Handle re-injection idempotently (cards re-render on filter/scroll).

5. **Maps scraper** (`src/maps/scraper.js`)
   - Executed in the hidden Maps tab (via `chrome.scripting.executeScript`). Resolves place,
     clicks Reviews, sorts Newest, scrolls to load a bounded number (e.g. up to ~20) reviews,
     returns `{placeId, rating, reviewCount, reviews:[...]}`. Robust selectors + timeouts.

## Files to create
- `manifest.json`
- `src/bayut/interceptor.js` (MAIN world)
- `src/bayut/content.js` (isolated: relay + IntersectionObserver + panel)
- `src/bayut/panel.css` (or inline via shadow DOM)
- `src/background/worker.js` (queue, cache, tab orchestration)
- `src/maps/scraper.js` (injected into hidden Maps tab)
- `README.md` (how to load unpacked, how caching works, known limitations)

## Constraints / quality bar
- No secrets, no external servers — everything client-side, cache in `chrome.storage.local`.
- Plain JS (no build step) unless trivially justified; keep it loadable-unpacked directly.
- Defensive selectors for Google Maps (aria/role/data-* first). Degrade gracefully when a
  building can't be matched (show a subtle "no Maps match" state, don't spam retries).
- Throttle-safe by construction: dedup, lazy, serial + jitter, hard cache, CAPTCHA-pause.
- Idempotent panel injection; survives Bayut's client-side re-renders.

## Success criteria
- Load unpacked → browse a Bayut rent search → within a few seconds, listing cards for a
  building show a rating + newest reviews panel, scraped from Google Maps, without stealing
  focus. Revisiting the same building is instant (cache hit, no new Maps tab).
