import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Injects the built asset list and a build-hash cache name into the
 * hand-rolled service worker (src/pwa/sw.js) and emits it as /sw.js.
 * Ported from sidestream's plugin — chosen over vite-plugin-pwa so the
 * whole caching policy stays readable in one screen and costs zero
 * runtime deps.
 *
 * Precache = every emitted client asset (hashed JS/CSS) + index.html +
 * everything in public/ EXCEPT public/data/ (runtime-cached by the
 * worker in its own persistent cache — precaching it would force ~1 MB
 * on every casual visitor and roll the shell cache on data-only
 * deploys) and og-image.jpg (fetched only by link-preview scrapers,
 * never by the app). The cache name is derived from the hash of all
 * precached content, so any change produces a new cache and an
 * activate-time purge of the old one.
 */

/**
 * Emitted files the Cloudflare Pages asset layer eats rather than
 * serves. Precaching one would poison the shell cache: the request
 * resolves to the SPA fallback, so addAll() "succeeds" while caching
 * index.html under a bogus key.
 */
const UNSERVED_BUNDLE_FILES = new Set(['_headers', '_redirects', '_routes.json']);

/** Served, but never requested by the app itself — excluded from both
 *  the precache and the digest so touching them doesn't roll the shell. */
const NOT_APP_ASSETS = new Set(['og-image.jpg']);

/** False for build/deploy metadata and for any dotfile, at any depth. */
export function isServedAsset(fileName: string): boolean {
  if (UNSERVED_BUNDLE_FILES.has(fileName)) return false;
  return !fileName.split('/').some((segment) => segment.startsWith('.'));
}

/** Should this public/ path (relative, forward-slashed) be precached? */
export function isPrecachedPublicAsset(relativePath: string): boolean {
  if (!isServedAsset(relativePath)) return false;
  if (relativePath === 'data' || relativePath.startsWith('data/')) return false;
  return !NOT_APP_ASSETS.has(relativePath);
}

export function currentlyServiceWorker(): Plugin {
  let root = process.cwd();
  return {
    name: 'currently-sw',
    apply: 'build',
    // Post: index.html is itself added to the bundle during generateBundle
    // (vite:build-html); running earlier would miss it.
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      // Only the environment carrying index.html gets a service worker.
      if (!bundle['index.html']) return;

      const hash = createHash('sha256');
      // '/' not '/index.html': Cloudflare Pages redirects /index.html → /
      // and a redirected cache entry can't answer an offline navigation.
      const precache = new Set<string>(['/']);

      // index.html's CONTENT must reach the digest even though it is
      // precached as '/' rather than by name: a build that changes only
      // index.html (a meta tag, the title) must still produce a new
      // sw.js, or the browser's update check finds nothing and the
      // precached '/' stays the old html indefinitely.
      const indexOutput = bundle['index.html'];
      hash.update('/');
      hash.update(indexOutput.type === 'chunk' ? indexOutput.code : String(indexOutput.source));

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === 'sw.js' || fileName === 'index.html') continue;
        if (!isServedAsset(fileName)) continue;
        precache.add(`/${fileName}`);
        hash.update(fileName);
        hash.update(output.type === 'chunk' ? output.code : String(output.source));
      }

      // public/ files are copied verbatim, not part of the bundle — walk
      // them. (Vite copies public/data/ into dist/data/ too; the filter
      // keeps it out of the precache, see header comment.)
      const publicDir = join(root, 'public');
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const relativePath = relative(publicDir, full).split('\\').join('/');
          if (statSync(full).isDirectory()) {
            if (isPrecachedPublicAsset(relativePath)) walk(full);
          } else {
            if (!isPrecachedPublicAsset(relativePath)) continue;
            const urlPath = `/${relativePath}`;
            precache.add(urlPath);
            hash.update(urlPath);
            hash.update(readFileSync(full));
          }
        }
      };
      walk(publicDir);

      const cacheName = `currently-shell-${hash.digest('hex').slice(0, 12)}`;
      const template = readFileSync(join(root, 'src/pwa/sw.js'), 'utf8');
      const source = template
        .replace('self.__CACHE_NAME__', JSON.stringify(cacheName))
        .replace('self.__PRECACHE__', JSON.stringify([...precache].sort()));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
