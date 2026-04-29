# Deployment

Step-by-step deployment of the *Currently* webapp to **currentlybc.com** on Cloudflare Pages, with the domain registered through the Cloudflare registrar.

This doc assumes you've read [app_implementation.md](app_implementation.md) §12 (Build & deploy). Where this file disagrees with §12 — for example, the basemap discussion — this file is current.

---

## 1. What you're deploying, and what you're not

**Deploying:** the contents of `web/dist/` (built by `npm run build`) plus `web/public/data/` (which Vite copies into `dist/data/` unchanged). All static bytes — HTML, JS, CSS, JSON, SVG. Total ~15 MB on disk today, ~1 MB on the wire after compression.

**Not deploying:**
- The Python pipeline (`read_tct.py`, `build_manifest.py`, `process_tct.sh`) — these run on your laptop to produce the JSONs that end up in `web/public/data/`.
- `node_modules/` — installed fresh by Cloudflare's build runner from `package-lock.json`.
- The PMTiles basemap — we don't have one yet. The map currently uses OpenFreeMap's hosted Liberty style ([web/src/map/map.ts:12](../web/src/map/map.ts#L12)). When/if we self-host PMTiles, see §8.

Bytes shipped per page-load (cold cache, gzip):
- JS bundle: ~325 KB
- CSS: ~15 KB
- HTML + icons + favicon: ~5 KB
- One year's data (4 JSONs): ~600 KB
- Basemap tiles: streamed from `tiles.openfreemap.org`, not from us
- **Total from our origin: ~1 MB**, well under any free-tier ceiling.

## 2. Why Cloudflare Pages

| Concern | CF Pages | GitHub Pages | Netlify |
|---|---|---|---|
| Cost (this app's traffic) | $0 | $0 | $0 |
| Bandwidth limit | Unlimited | Soft 100 GB/mo | 100 GB/mo |
| Custom domain | Free | Free | Free |
| Build runner | Yes | Via Actions | Yes |
| Cache header control | `_headers` file | None | `_headers` file |
| Per-file size cap | 25 MB | 100 MB soft | None |
| Lives next to your registrar | **Yes** | No | No |

Pages wins on the last row: since `currentlybc.com` is registered at Cloudflare, DNS for the custom domain attaches in one click without you ever editing a record by hand.

## 3. Prerequisites checklist

Before starting:

- [ ] `currentlybc.com` purchased through Cloudflare registrar. The zone shows up automatically in Cloudflare's dashboard under **Websites**. Buy with WHOIS redaction on (free, default), auto-renew on, and Cloudflare's nameservers (default). Click the ICANN verification email within 15 days or the domain gets suspended.
- [ ] Repo pushed to GitHub (or GitLab — Pages supports both). CF Pages reads from the remote, not your laptop.
- [ ] `release` branch exists on the remote and points at the commit you want live. `release` is the production branch; `main` is the iteration branch (see §4 for the why).
- [ ] `web/package-lock.json` committed. `npm ci` requires it.
- [ ] `web/.nvmrc` committed (currently pins Node 22). CF reads this automatically.
- [ ] `web/vite.config.ts` sets `base: './'` so built asset paths work on both apex and preview hostnames.
- [ ] `web/public/_headers` committed (see §5) so the very first deploy serves the right cache policy.
- [ ] Local build is clean: `cd web && npm ci && npm run build` produces `web/dist/` with no errors and `dist/_headers` present.

## 4. Create the Pages project

### 4.1 Finding the Pages flow (it's partially hidden)

Cloudflare has been steering new projects toward "Workers + Static Assets" and the standalone Pages create button is no longer obvious in the UI. The default **Workers & Pages → Create** button now drops you in the Workers flow ("Create a Worker"). That's the wrong path for this project — our `_headers` file, build config, and this doc all assume Pages.

To reach the Pages create flow directly:

```
https://dash.cloudflare.com/?to=/:account/pages/new/provider/github
```

Cloudflare resolves `:account` automatically. If that URL bounces you, navigate to `dash.cloudflare.com/?to=/:account/pages` (the Pages project list) and click **Create a project**. The page title should read **"Create a project"** with a step labeled **"Connect to Git"**, *not* **"Create a Worker"**.

### 4.2 Authorise GitHub and select the repo

One-time: grant CF read access to either all your repos or just the `currently` repo. Then select the repo.

### 4.3 Build configuration

On the **Set up builds and deployments** screen, enter exactly:

| Field | Value |
|---|---|
| Project name | `currently` (becomes `currently.pages.dev`) |
| Production branch | `release` |
| Framework preset | **None** |
| Build command | `cd web && npm ci && npm run build` |
| Build output directory | `web/dist` |
| Root directory (advanced) | *leave blank* |
| Environment variables | *none needed* |

Notes on the non-obvious choices:

- **Production branch `release`, not `main`.** This is deliberate. We use `main` as the iteration branch (push freely, get private preview deploys at `main.currently.pages.dev`) and promote to `release` only when we want the public site to update. To publish: `git push origin main:release` (or open a `main → release` PR if you want a paper trail). Pushing to `main` does *not* update `currentlybc.com`.
- **Framework preset "None"** — Vite is listed, but the preset assumes the project root is the Vite project. Ours is in `web/`, so we override the build command instead. None is cleaner.
- **Build output `web/dist`** — relative to repo root, *not* relative to the build command's cwd. Pages runs the command, then looks for the output at this path from the repo root.
- **No `NODE_VERSION` env var needed** — CF reads `web/.nvmrc` automatically. If you ever want to override, add `NODE_VERSION=22` in the env vars section.

Click **Save and Deploy**. The first build runs immediately (~1–2 min) against whatever `release` currently points at. When it finishes, your site is live at `https://currently.pages.dev`. Click through and verify it works before attaching the custom domain.

## 5. The `_headers` file (cache policy)

Cache headers are load-bearing per [app_implementation.md §4.3](app_implementation.md#L144) — `manifest.json` *must* be revalidated on every load so that data drops are picked up promptly, while hashed assets *must* be cached forever so repeat visits are instant.

Create `web/public/_headers` with this content:

```
/index.html
  Cache-Control: no-cache

/
  Cache-Control: no-cache

/manifest.webmanifest
  Cache-Control: no-cache

/data/manifest.json
  Cache-Control: no-cache, must-revalidate

/data/*
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/favicon.svg
  Cache-Control: public, max-age=86400

/icons.svg
  Cache-Control: public, max-age=86400
```

Vite copies `public/_headers` into `dist/_headers` unchanged. Pages reads it at deploy time.

A few things to know:

- The first matching rule wins, top-down. Order matters: put more-specific paths before broader ones.
- Pages applies `Content-Encoding: br` (brotli) automatically on top of whatever you set here. Don't try to set it yourself.
- **Two rules for the index page** (`/` and `/index.html`): CF Pages matches paths literally, so a request for `/` doesn't match the `/index.html` rule. Without the explicit `/` rule, Pages falls back to its default (`max-age=0, must-revalidate`), which is functionally close to `no-cache` but not identical to what we declare.
- **`/data/*` (single trailing splat), not `/data/*/*.json`.** CF Pages' `_headers` matcher reliably handles literal paths and single trailing splats, but multi-splat patterns with extension constraints (`/data/*/*.json`) silently don't match. Since the literal `/data/manifest.json` rule comes first, manifest.json gets the no-cache policy and everything else under `/data/` (the hashed yearly JSONs) falls through to the immutable rule.
- `data/manifest.json` is not hashed, so it gets the no-cache policy. This is the one file the browser must revalidate on every load.
- `assets/*` is where Vite puts its own hashed JS/CSS bundles (e.g. `assets/index-BzHW9vuW.js`).

## 6. Attach the custom domain

In the Pages project, **Custom domains → Set up a custom domain**.

Add both:

- `currentlybc.com`
- `www.currentlybc.com`

Cloudflare detects that the zone is in your account and auto-creates the DNS records (CNAME for www, a flattened CNAME / A record for apex). No manual record editing required. Provisioning the SSL cert takes 30 seconds to a couple of minutes.

Decide which one is canonical. The convention for marketing sites is apex (`currentlybc.com`) with `www` redirecting to it. To set up the redirect:

**Cloudflare dashboard → currentlybc.com zone → Rules → Redirect Rules → Create rule:**

| Field | Value |
|---|---|
| Rule name | `www → apex` |
| When incoming requests match | Hostname equals `www.currentlybc.com` |
| Then | Static redirect |
| Type | 301 |
| URL | `https://currentlybc.com${request.uri.path}` |
| Preserve query string | On |

(Or run it the other way — apex → www — if that's your preference. Whatever you pick, pick one and stick with it.)

## 7. Verifying the first real deploy

After the deploy finishes, open `https://currentlybc.com` and check:

**Functionality:**
- [ ] Map renders, basemap tiles load.
- [ ] Stations appear and have values.
- [ ] Scrubber moves; values update.
- [ ] Tap a tide station — chart and 5-day panel appear.

**Cache headers** (DevTools → Network, hard reload, click each row → Headers tab):
- [ ] `/` (index.html): `cache-control: no-cache`
- [ ] `/data/manifest.json`: `cache-control: no-cache, must-revalidate`
- [ ] `/data/2026/tidal_primary.{hash}.json`: `cache-control: public, max-age=31536000, immutable`
- [ ] `/assets/index-{hash}.js`: `cache-control: public, max-age=31536000, immutable`

**Compression:**
- [ ] JSON and JS responses have `content-encoding: br` (or `gzip`).
- [ ] Transfer size in DevTools is much smaller than resource size — e.g. `current_primary.{hash}.json` should show ~400 KB transfer for ~10 MB resource.

**HTTPS / domain:**
- [ ] `currentlybc.com` works (cert valid).
- [ ] `www.currentlybc.com` redirects to `currentlybc.com` (or vice versa, depending which you chose).
- [ ] `http://currentlybc.com` redirects to `https://`. (Cloudflare does this automatically when the zone has "Always Use HTTPS" enabled — verify under SSL/TLS → Edge Certificates.)

If any of the above fails, see §10.

## 8. Future: self-hosted PMTiles basemap

The plan in [app_implementation.md §6.1](app_implementation.md#L194) calls for a local PMTiles basemap. We're not there yet — `web/src/map/map.ts:12` points at OpenFreeMap. When we switch:

- A BC-coast OSM extract is ~30–50 MB. **CF Pages caps at 25 MB per file**, so the PMTiles file cannot live in the Pages bundle.
- Use **Cloudflare R2** (their S3-compatible object storage). Free tier: 10 GB storage, 10 M class-A ops/month, **zero egress** to anywhere. Range requests work, which is what PMTiles needs.

Setup sketch (when you're ready):

1. **Dashboard → R2 → Create bucket** named e.g. `currently-tiles`. Region: leave default (auto). Public access: enable.
2. Attach a custom subdomain like `tiles.currentlybc.com` to the bucket (Settings → Custom domains).
3. Set bucket-level CORS to allow `GET` from `https://currentlybc.com` and `https://currently.pages.dev`. Required headers: `Range`, `If-Match`. Exposed headers: `ETag`, `Content-Range`.
4. Upload `bc.pmtiles` via `wrangler r2 object put currently-tiles/bc.pmtiles --file=bc.pmtiles --content-type application/octet-stream --cache-control "public, max-age=2592000"`.
5. In `web/src/map/map.ts`, swap the basemap style URL for one that references `pmtiles://https://tiles.currentlybc.com/bc.pmtiles` and register the PMTiles protocol with MapLibre. (See the `protomaps/PMTiles` JS library README for the exact wiring.)

The R2 bucket is independent of the Pages project — you can set it up whenever, no migration needed. Until then, OpenFreeMap is fine.

## 9. Annual data drop

When CHS publishes the next year's tables (typically late autumn):

```bash
# 1. Place the new PDFs in repo root (vol5_2027.pdf, etc.)
# 2. Re-run the parser + manifest build
./process_tct.sh

# 3. Verify locally
ls web/public/data/2027/                     # four JSONs should appear
cat web/public/data/manifest.json            # 2027 entry should be present

# 4. Smoke-test in dev
cd web && npm run dev                        # check the new year scrubs cleanly

# 5. Commit to main and push
cd ..
git add web/public/data/2027/ web/public/data/manifest.json
git commit -m "Add 2027 CHS tables"
git push origin main

# 6. Smoke-test the preview deploy
#    Open https://main.currently.pages.dev — confirm 2027 scrubs cleanly
#    on the live build (not just `npm run dev`).

# 7. Promote to production
git push origin main:release
```

Pushing to `release` triggers CF Pages automatically. About 90 seconds later `currentlybc.com` is serving 2027 data. Browsers with a stale `manifest.json` revalidate on next load (the no-cache header earns its keep here) and pick up the new year without a force-refresh.

No app code changes. No Pages settings change. No version bump.

The same promote pattern (`git push origin main:release`) applies to any other change you want to publish — bug fixes, new features, copy edits. Iterate on `main`, verify on the preview URL, then promote.

## 10. Troubleshooting

**Build fails with `npm ci` errors.** Delete `web/node_modules` and `web/package-lock.json` locally, run `npm install`, commit the new lockfile, push. Local Node major must be ≥ what `.nvmrc` pins.

**Build succeeds but site is blank.** Almost always a `base` path issue. `web/vite.config.ts` should have `base: "./"` per [app_implementation.md §12.3](app_implementation.md#L463). Check the deployed `index.html` for `<script src="...">` paths — they should be relative.

**`manifest.json` doesn't update after a data push.** Hard-reload once. If it still serves stale, check the response's `cache-control` header in DevTools — it should be `no-cache, must-revalidate`. If you see `max-age=...`, your `_headers` file isn't matching that path. The `/data/manifest.json` rule must come *before* the `/data/*/*.json` rule.

**Hashed JSONs return 404 after a deploy.** The browser cached `manifest.json` pointing at old hashes, but the deploy removed those files. Hard-reload pulls the new manifest. The fact that this self-heals is *why* `manifest.json` is no-cache.

**`www` doesn't redirect.** Check **Rules → Redirect Rules** is enabled and the rule is on. Also confirm the `www` subdomain is attached as a custom domain on the Pages project — without that, the redirect rule never gets a chance to fire because there's no cert.

**Build runs the old commit.** CF Pages has a build cache. **Deployments tab → ⋯ → Retry deployment** with "Clear build cache" if you suspect staleness. Rare.

**Wanting to roll back.** Pages keeps every deployment. **Deployments tab → previous good deployment → Rollback**. Instant; no rebuild needed.

## 11. Costs and limits to keep an eye on

CF Pages free tier — current usage is well under all of these, but worth knowing:

| Limit | Free tier | This app |
|---|---|---|
| Builds per month | 500 | ~5–30 (depends on push frequency) |
| Concurrent builds | 1 | fine |
| Custom domains per project | 100 | 2 |
| Sites per account | 100 | 1 |
| Files per deployment | 20,000 | ~30 |
| File size | 25 MB | largest is 10 MB (current_primary.json) |
| Bandwidth | Unlimited | — |
| Requests | Unlimited | — |

The two limits with future relevance: **build minutes** (if a CI loop ever pushes too aggressively) and **per-file size** (if `current_primary.json` ever grows past 25 MB once Vols 1–4 are added — see [app_implementation.md §4.1](app_implementation.md#L106)). Neither is close today.

The domain itself costs whatever the registrar lists — Cloudflare sells `.com` at wholesale (around USD $10/yr), no markup. That's the only recurring cost of this entire stack.
