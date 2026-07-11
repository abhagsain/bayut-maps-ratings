# Bayut Google Maps Ratings Extension

See a building's **Google Maps rating and latest reviews right on its [Bayut](https://www.bayut.com) listing** — so you can skip badly-rated buildings without looking each one up on Google Maps.

When you're flat-hunting on Bayut, a listing can look great while the building itself has broken lifts, poor maintenance, or noisy neighbours — the kind of thing you'd only find out from its Google Maps reviews. Normally you'd copy each building's name into Google Maps, read the reviews, and go back… for every single listing. It's slow and easy to miss a red flag.

This free browser add-on does that step for you automatically. Every listing gets a small ⭐ rating badge, and hovering it shows the star breakdown and the newest reviews. It remembers what it has already checked, so it's instant the next time you see the same building. It works on both the normal list view and the map view, there's no sign-up, and nothing you do leaves your own browser.

> I built this for my own apartment search in Dubai because I got tired of checking every building's reviews by hand.

![Bayut listings with Google Maps rating badges and an open review popover](docs/images/screenshot-map-view.png)

> **Note:** This is a personal-use tool that scrapes Google Maps by driving hidden background tabs. It is not affiliated with Bayut or Google, and is meant for local unpacked use only — not Chrome Web Store distribution.

## Install it yourself

**You'll need:** Google Chrome (or another Chrome-based browser like Edge or Brave), and to be signed in to your Google account in that browser.

1. Get the code — either clone it:
   ```bash
   git clone https://github.com/abhagsain/bayut-maps-ratings.git
   ```
   or download the ZIP from the GitHub page (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Open the puzzle-piece extensions menu and **pin** *Bayut Google Maps Ratings* so the progress popup is one click away.
6. Browse a Bayut rental/sale search page. Ratings appear on each listing as they load; the first time it sees a building it looks it up on Google Maps (a few seconds), and after that it's instant.

There is no build step and no dependencies — it's plain JavaScript loaded straight from the folder.

**Updating:** `git pull` (or re-download), then click the reload icon on the extension card in `chrome://extensions`. If a new version adds a permission, remove the extension and **Load unpacked** again.

## Using it

- **Badge:** each listing shows a compact `★ rating · N reviews` badge (inline under the location in list view, overlaid on the thumbnail in map view) plus a Google Maps icon link.
- **Popover:** hover the badge for the rating distribution, per-review stars, and newest review snippets, with **Newest / Highest / Lowest** sorting.
- **Progress:** click the pinned icon for live scraping status and cache size; open the dashboard for the full cached-building table.

---

*Everything below is for developers — if you just want to use the extension, you're all set above.*

## How it works

It's a plain-JavaScript Manifest V3 Chrome extension (no build step, no dependencies). It reads each listing's building and coordinates from Bayut's own search data, resolves the Google Maps place, and scrapes the rating, rating distribution, and newest reviews — deliberately without the Google Places API, which caps reviews at 5 and can't sort by newest. Results are cached locally so each building is only scraped once.

- `src/bayut/interceptor.js` runs in Bayut's MAIN world at `document_start`, reads the initial server-rendered `window.state.algolia.content` hits, and intercepts the page's later Algolia `fetch` and XHR responses.
- `src/bayut/content.js` runs in the isolated extension world, records Bayut listing hits, observes visible listing cards, and injects an idempotent shadow-DOM rating badge plus hover popover.
- `src/background/worker.js` deduplicates by building key, checks `chrome.storage.local`, and scrapes Google Maps through a small pool of reused inactive tabs.
- `src/maps/scraper.js` is injected into inactive Maps tabs. It resolves the place, opens reviews, sorts by newest, scrolls a bounded review list, and returns rating, review count, and newest review snippets.

## Bayut DOM anchors

The content script uses these verified stable Bayut selectors in `src/bayut/content.js`:

- Listing card: `li[aria-label="Listing"]` (matches both list and map views)
- Listing detail link: `a[aria-label="Listing link"]`
- External listing ID: parsed from link hrefs like `/property/details-15722544.html`
- Badge placement anchor: `[aria-label="Location"]`

If Bayut changes its markup, update the selector constants near the top of `src/bayut/content.js`. Rendered cards are mapped to intercepted Algolia hits by `externalID`; DOM matching does not use geography. In list view the badge host is inserted immediately after the location element so it stays in the details column. In map view (`map_active`/`commute_active`) it is overlaid on the listing thumbnail, attached to the untransformed `article[aria-label="Listing card"]` so the popover — which is portaled to a single `document.body`-level layer — is never clipped or occluded by neighbouring cards.

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

## License

[MIT](LICENSE) © Anurag Bhagsain.

I also built :)
- [SlidesAI - An AI Presentation Maker](https://slidesai.io?ref=bayut-github)
- [AI CLI](https://github.com/abhagsain/ai-cli)
- [Read Changelogs](https://github.com/abhagsain/read-changelogs)

And more on my [Github](https://github.com/abhagsain) 
