import { describe, expect, it } from 'vitest';
import { isPrecachedPublicAsset, isServedAsset } from './vite-plugin-sw';

// The precache filter is load-bearing in two directions: including an
// unserved path (e.g. _headers) makes addAll() cache the SPA fallback
// under a bogus key, and including public/data/ would force ~1 MB onto
// every visitor at install and roll the shell cache on data-only deploys.

describe('isServedAsset', () => {
  it('rejects deploy metadata and dotfiles at any depth', () => {
    expect(isServedAsset('_headers')).toBe(false);
    expect(isServedAsset('_redirects')).toBe(false);
    expect(isServedAsset('.DS_Store')).toBe(false);
    expect(isServedAsset('icons/.hidden/foo.png')).toBe(false);
  });

  it('accepts ordinary served files', () => {
    expect(isServedAsset('assets/index-abc123.js')).toBe(true);
    expect(isServedAsset('favicon.ico')).toBe(true);
  });
});

describe('isPrecachedPublicAsset', () => {
  it('excludes the data tree (runtime-cached, not precached)', () => {
    expect(isPrecachedPublicAsset('data')).toBe(false);
    expect(isPrecachedPublicAsset('data/manifest.json')).toBe(false);
    expect(isPrecachedPublicAsset('data/2026/tidal_primary.477a7ba9.json')).toBe(false);
  });

  it('excludes assets the app itself never fetches', () => {
    expect(isPrecachedPublicAsset('og-image.jpg')).toBe(false);
  });

  it('includes icons and the web manifest', () => {
    expect(isPrecachedPublicAsset('site.webmanifest')).toBe(true);
    expect(isPrecachedPublicAsset('web-app-manifest-192x192.png')).toBe(true);
    expect(isPrecachedPublicAsset('apple-touch-icon.png')).toBe(true);
  });

  it('does not treat a data-prefixed filename as the data tree', () => {
    expect(isPrecachedPublicAsset('database-icon.png')).toBe(true);
  });
});
