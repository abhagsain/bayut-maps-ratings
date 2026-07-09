# Bayut Google Maps Ratings Extension

Personal-use Manifest V3 Chrome extension that adds cached Google Maps ratings and newest review snippets to Bayut listing cards.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Browse a Bayut rental search page while signed into Google in the same Chrome profile.

There is no build step. The extension is plain JavaScript and loads directly from this folder.
To keep the progress popup handy, open Chrome's puzzle-piece extensions menu and pin **Bayut Google Maps Ratings**.

## How it works

- `src/bayut/interceptor.js` runs in Bayut's MAIN world at `document_start`, reads the initial server-rendered `window.state.algolia.content` hits, and intercepts the page's later Algolia `fetch` and XHR responses.
- `src/bayut/content.js` runs in the isolated extension world, records Bayut listing hits, observes visible listing cards, and injects an idempotent shadow-DOM rating badge plus hover popover.
- `src/background/worker.js` deduplicates by building key, checks `chrome.storage.local`, and scrapes Google Maps through a small pool of reused inactive tabs.
- `src/maps/scraper.js` is injected into inactive Maps tabs. It resolves the place, opens reviews, sorts by newest, scrolls a bounded review list, and returns rating, review count, and newest review snippets.

## Bayut DOM anchors

The content script uses these verified stable Bayut selectors in `src/bayut/content.js`:

- Listing card: `li[role="article"][aria-label="Listing"]`
- Listing detail link: `a[aria-label="Listing link"]`
- External listing ID: parsed from link hrefs like `/property/details-15722544.html`
- Badge placement anchor: `div[aria-label="Location"]`

If Bayut changes its markup, update the selector constants near the top of `src/bayut/content.js`. Rendered cards are mapped to intercepted Algolia hits by `externalID`; DOM matching does not use geography. The badge host is inserted immediately after the location div so it stays in the details column and does not overlap listing photos.

## Cache

The cache is stored in `chrome.storage.local` with a 14-day TTL:

- `building:<building-name-and-rounded-coordinates>` points to the resolved Google place ID or a temporary no-match entry.
- `place:<google-place-id>` stores rating, review count, review snippets, Maps URL, and scrape time.

Listings for the same building should become instant after the first successful scrape.

## Popup and dashboard

Click the pinned extension icon to see live scraping progress: queued buildings, active scraping count, cache size, and cached review snippets. The popup includes **Refresh**, **Open dashboard**, and **Clear cache** actions.

The dashboard opens as a full tab and shows the cached building table with filtering, sortable columns, Maps links, and the same live scraping status strip. Use **Clear cache** in either view to remove all `building:*` and `place:*` cache entries while leaving queue bookkeeping intact.

## Debugging

All extension logs are prefixed with `[BayutRatings]`.

- Worker logs: open `chrome://extensions`, find **Bayut Google Maps Ratings**, then open **Inspect views: service worker**. Filter the console by `[BayutRatings]` or `[BayutRatings][worker]`.
- Bayut page logs: open normal DevTools on `bayut.com` and filter the console by `[BayutRatings]`, `[BayutRatings][interceptor]`, or `[BayutRatings][content]`.
- Maps scraper logs: while a hidden Maps tab is open, inspect that tab to see `[BayutRatings][scraper]` logs.

## Known limitations

- Google Maps DOM selectors are private and can change. The scraper prefers aria, role, and data attributes, and review text is read only from the verified `.wiI7pd` Maps review-text node to avoid action-button/icon noise.
- If Google shows a human-verification page, the queue pauses and the Maps tab is surfaced for manual action.
- Bayut listings without a building name fall back to neighbourhood plus coordinates, which can resolve less precisely.
- The extension is intended only for personal unpacked use, not Chrome Web Store distribution.
