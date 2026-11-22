// Deployment: a Worker that serves dist/ as static assets at
// https://kseo.ink/poc/seosynth/. Nothing runs on the server.
//
// The rest of kseo.ink is another Worker (asobi). A route runs before the
// Worker that owns the hostname, so these two routes take over just this path.
import { defineConfig, triggers } from 'cf/config';
import { BASE_PATH } from './scripts/site.ts';

const ZONE = 'kseo.ink';

export default defineConfig({
  worker: {
    name: 'seosynth',
    compatibilityDate: '2026-11-01',
    assets: {
      // Files stay at the root of dist/; requests carry the prefix.
      basePath: BASE_PATH,
      // /poc/seosynth redirects to /poc/seosynth/, so the page's
      // relative paths (js/, css/, wasm/) resolve under the prefix.
      htmlHandling: 'auto-trailing-slash',
      notFoundHandling: 'none',
    },
    triggers: [
      triggers.fetch({ pattern: `${ZONE}${BASE_PATH}`, zone: ZONE }),
      triggers.fetch({ pattern: `${ZONE}${BASE_PATH}/*`, zone: ZONE }),
    ],
    // Only reachable on kseo.ink.
    workersDev: false,
  },
});
