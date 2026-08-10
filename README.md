# Site Inspection — Setup Guide

## Updating an existing install

**Easiest method (v0.4+):** open the app, tap the **⟳** icon on the home screen (top right, next to the templates menu). This clears the cached app files and service worker, then reloads — pulling fresh files straight from GitHub Pages. Use this any time after you've pushed an update, instead of waiting on iOS's own background check.

**Manual method:** upload the updated files over the old ones in your repo (same file paths). Your existing inspections, elements, findings, and photos are preserved automatically — the local database upgrades itself in place. If the ⟳ button isn't available yet (i.e. updating from a version before it existed), remove the app from the home screen, reload the site in Safari once online, then re-add it.


This is a local-first PWA. It stores everything on the iPad itself (IndexedDB) and works fully offline once installed. No App Store, no account.

## 1. Hosting it (one-time requirement)

iOS requires a PWA to be served over **HTTPS** (or `localhost`) before it can be installed and use the camera. You only need this for the initial install — after that it runs offline. Easiest options, roughly in order of simplicity:

**Option A — GitHub Pages (free, no server to maintain)**
1. Create a new GitHub repo, upload the contents of this folder (not the zip — the files inside it).
2. Settings → Pages → deploy from the `main` branch, root folder.
3. GitHub gives you a URL like `https://yourname.github.io/site-inspection/`. Open that in Safari on the iPad.

**Option B — Netlify Drop**
1. Go to `app.netlify.com/drop` in a browser.
2. Drag the unzipped `inspection-app` folder onto the page.
3. It gives you an HTTPS URL instantly. Open it in Safari on the iPad.

**Option C — Any existing web host / internal server**
Upload the folder as-is to any static file host (S3 + CloudFront, an internal IIS/nginx server, etc.) — it's plain HTML/CSS/JS, no build step, no server-side code required.

## 2. Installing on the iPad

1. Open the hosted URL in **Safari** (must be Safari, not Chrome, for "Add to Home Screen" to create a full PWA).
2. Tap the Share icon → **Add to Home Screen**.
3. Open the app from the home screen icon from now on (not the Safari bookmark) — this gives it the full-screen, no-browser-chrome experience and the most reliable offline storage.
4. The first time it opens, make sure the iPad has internet access briefly — this lets it cache the PDF-export library for offline use afterward. After that first load, it works with no connection at all.

## 3. Permissions

The first time you take a photo or capture GPS location, iOS will prompt for Camera and Location permission — accept both from within the app (Settings → the app name if you need to change it later).

## 4. Apple Pencil Pro

No setup needed — open any photo's markup screen and draw. Pressure sensitivity is picked up automatically via Safari's pointer input support. Palm rejection is handled by iOS/Safari automatically while using the Pencil.

## 5. Backing up data

Everything lives in the browser's local storage on that specific iPad. Because iOS can occasionally clear site data under storage pressure (especially if the app goes unused for a long stretch), **export a PDF report for any inspection you want to keep permanently**, and consider periodically saving those PDFs to Files/iCloud/email. There is currently no cloud sync — this is intentional, per the local-only brief.

## Notes on file structure

- `index.html` — app shell
- `css/styles.css` — styling
- `js/db.js` — IndexedDB data layer (inspections, elements, findings, photos, templates)
- `js/app.js` — views, routing, forms
- `js/annotate.js` — Pencil markup canvas
- `js/pdf.js` — PDF report export (uses jsPDF, loaded from CDN and cached offline)
- `sw.js` — service worker (offline caching)
- `manifest.json` — PWA install metadata
