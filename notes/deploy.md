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
| Project name | `currently` — but expect a suffix: `currently.pages.dev` is globally namespaced and was already taken when this project deployed, so CF appended a random suffix and you got `currently-XXX.pages.dev`. Doesn't matter operationally — the custom domain hides this. |
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

/data/manifest.json
  Cache-Control: no-cache, must-revalidate

/data/2*
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/site.webmanifest
  Cache-Control: public, max-age=86400

/favicon.ico
  Cache-Control: public, max-age=86400

/favicon-96x96.png
  Cache-Control: public, max-age=86400

/apple-touch-icon.png
  Cache-Control: public, max-age=86400

/web-app-manifest-192x192.png
  Cache-Control: public, max-age=86400

/web-app-manifest-512x512.png
  Cache-Control: public, max-age=86400

/og-image.jpg
  Cache-Control: public, max-age=86400

/icons.svg
  Cache-Control: public, max-age=86400
```

Vite copies `public/_headers` into `dist/_headers` unchanged. Pages reads it at deploy time.

A few things to know:

- Pages applies `Content-Encoding: br` (brotli) automatically on top of whatever you set here. Don't try to set it yourself.
- **Two rules for the index page** (`/` and `/index.html`): CF Pages matches paths literally, so a request for `/` doesn't match the `/index.html` rule. Without the explicit `/` rule, Pages falls back to its default (`max-age=0, must-revalidate`), which is functionally close to `no-cache` but not identical to what we declare.
- **`/data/2*`, not `/data/*` and not `/data/*/*.json`.** Two CF Pages `_headers` gotchas in one rule:
  1. Multi-splat patterns with extension constraints (`/data/*/*.json`) silently don't match — only literal paths and single trailing splats are reliable.
  2. CF Pages does **not** do first-match-wins for `Cache-Control`. Multiple matching rules each contribute their directives, which get *concatenated* into one merged header. So if both `/data/manifest.json` (no-cache) and `/data/*` (immutable) match the manifest path, the response gets `cache-control: no-cache, must-revalidate, public, max-age=31536000, immutable` — contradictory directives that browsers may resolve in favor of `immutable`, silently breaking the data-drop story.
  
  The fix: use a splat that *doesn't* overlap with the literal manifest rule. `/data/2*` matches yearly folders (`/data/2026/...`, `/data/2027/...`) but not `/data/manifest.json`. Future-proof until year 3000.
- `data/manifest.json` is not hashed, so it gets the no-cache policy. This is the one file the browser must revalidate on every load.
- `assets/*` is where Vite puts its own hashed JS/CSS bundles (e.g. `assets/index-BzHW9vuW.js`).

## 6. Attach the custom domain

### 6.1 Add both domains to the Pages project

In the Pages project, **Custom domains → Set up a custom domain**. Add each, one at a time:

- `currentlybc.com`
- `www.currentlybc.com`

Cloudflare detects that the zone is in your account and auto-creates the DNS records (CNAME for www, a flattened CNAME / A record for apex). No manual record editing required. Provisioning the SSL cert takes 30 seconds to a couple of minutes; status flips from "Verifying" → **Active** when both DNS and cert are ready.

### 6.2 SSL/TLS settings to verify

Before deploying the redirect rule, confirm three settings on the zone. These are mostly defaults, but worth eyeballing:

**SSL/TLS → Overview:**
- [ ] **Encryption mode = Full (strict)**. If yours says **Full** (without strict), click Configure and switch — Full (strict) validates the origin cert (CF Pages always has a valid one). If yours says **Flexible**, switch immediately; Flexible would let CF talk to Pages over plain HTTP, which is wrong.

**SSL/TLS → Edge Certificates:**
- [ ] **Always Use HTTPS = On**. Redirects `http://` → `https://` automatically, which §7 verifies.
- [ ] **Automatic HTTPS Rewrites = On**. Fixes mixed-content links inside HTML — cheap insurance.
- [ ] In the certificate table, look for a Universal cert covering `*.currentlybc.com, currentlybc.com` with status **Active**. CF auto-renews; you do nothing.

Ignore the upsells (**Order an advanced certificate**, **Activate ACM**, **Upgrade to Business**). Free-tier Universal SSL is sufficient.

### 6.3 The www → apex redirect

Decide which is canonical. The convention for marketing sites is apex (`currentlybc.com`) with `www` redirecting to it.

**The easy path: use the template.** Navigate to the zone's **Rules → Overview** (not Rules → Page Rules — Page Rules is the legacy feature, capped at 3 on the free plan). Find the **"Redirect from www to root"** template and click it. CF pre-fills a Single Redirect rule:

| Field | Pre-filled value | Action |
|---|---|---|
| Rule name | `Redirect from WWW to root [Template]` | Leave |
| Match type | Wildcard pattern | Leave |
| Request URL | `https://www.*` | Leave — wildcard captures everything after `www.` |
| Target URL | `https://${1}` | Leave — `${1}` is the captured tail |
| Status code | `301 - Permanent Redirect` | Leave |
| Preserve query string | unchecked | **Check this box** so `?utm_source=...` survives the redirect |

Click **Deploy**. If a popup warns *"This rule may not apply to your traffic — DNS configuration may not be proxying traffic for www"*, that's a **false positive** for Pages-managed CNAMEs (verify by opening DNS → Records in another tab and confirming the `www` row shows the orange-cloud Proxied status). Pick **"Ignore and deploy rule anyway"** and continue. **Do not pick "Create a new proxied DNS record"** — that creates a duplicate alongside the Pages-managed one and can break the custom domain.

**The manual path** (if the template isn't there for some reason): Rules → Redirect Rules → Create rule, with values: name `www → apex`, match Hostname equals `www.currentlybc.com`, Then Static redirect, Type 301, URL `https://currentlybc.com${request.uri.path}`, Preserve query string On.

(Or run it the other way — apex → www — if that's your preference. Whatever you pick, pick one and stick with it.)

## 7. Verifying the first real deploy

After the deploy finishes, run through the checks below.

### 7.1 Functionality (browser, 30 seconds)

Open `https://currentlybc.com`:
- [ ] Map renders, basemap tiles load.
- [ ] Stations appear and have values.
- [ ] Scrubber moves; values update.
- [ ] Tap a tide station — chart and 5-day panel appear.

### 7.2 Cache headers + compression (curl, copy-pasteable)

This is the fastest way to verify all the cache rules at once. Replace the hashed filenames with whatever's in `web/public/data/manifest.json` for the current year and the `assets/index-*.js` filename from `dist/index.html`:

```bash
URLS=(
  "https://currentlybc.com/"
  "https://currentlybc.com/data/manifest.json"
  "https://currentlybc.com/data/2026/current_primary.<hash>.json"
  "https://currentlybc.com/data/2026/tidal_primary.<hash>.json"
  "https://currentlybc.com/assets/index-<hash>.js"
  "https://currentlybc.com/favicon.svg"
)
for u in "${URLS[@]}"; do
  HEADERS=$(curl -sD - -o /dev/null -H "Accept-Encoding: br, gzip" "$u")
  echo "=== $u ==="
  echo "$HEADERS" | head -1 | tr -d '\r'
  echo "$HEADERS" | grep -i "^cache-control:" | tr -d '\r'
  echo "$HEADERS" | grep -i "^content-encoding:" | tr -d '\r'
done
```

Expected:

| URL | Status | Cache-Control | Content-Encoding |
|---|---|---|---|
| `/` | 200 | `no-cache` | `br` |
| `/data/manifest.json` | 200 | `no-cache, must-revalidate` | `br` |
| `/data/{year}/*.json` | 200 | `public, max-age=31536000, immutable` | `br` |
| `/assets/index-*.js` | 200 | `public, max-age=31536000, immutable` | `br` |
| `/favicon.svg` | 200 | `public, max-age=86400` | `br` |

If `/data/manifest.json` returns multiple comma-separated cache directives (e.g. `no-cache, must-revalidate, public, max-age=31536000, immutable`), your `_headers` has overlapping rules merging — see §5's gotcha 2 and §10.

If you'd rather use DevTools: Network tab, hard-reload, click each row → Headers tab. Same expectations apply. Transfer size should be much smaller than resource size — e.g. `current_primary.{hash}.json` shows ~400 KB transfer for ~10 MB resource.

### 7.3 Redirect chains (curl one-liner)

```bash
for u in https://www.currentlybc.com http://currentlybc.com http://www.currentlybc.com https://currentlybc.com; do
  echo "=== $u ==="
  curl -sIL "$u" | grep -iE "^(HTTP/|location:)"
done
```

Expected:
- [ ] `https://www.currentlybc.com` → 301 → `https://currentlybc.com/` → 200
- [ ] `http://currentlybc.com` → 301 → `https://currentlybc.com/` → 200 (Always Use HTTPS)
- [ ] `http://www.currentlybc.com` → 301 → `https://www.currentlybc.com/` → 301 → `https://currentlybc.com/` → 200 (chains both rules)
- [ ] `https://currentlybc.com` → 200 directly (no redirect)

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

**`manifest.json` doesn't update after a data push.** Hard-reload once. If it still serves stale, check the response's `cache-control` header (DevTools or `curl -sI`) — it should be exactly `no-cache, must-revalidate`. If you see extra directives concatenated (`...public, max-age=31536000, immutable`), the `/data/2*` rule is somehow matching the manifest path — check that the immutable rule's pattern is `/data/2*` (or another non-overlapping splat) and not `/data/*`. See §5's gotcha 2.

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
