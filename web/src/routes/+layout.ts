// The web UI is a single-page app served from the Alnair binary, so there is
// no server-side render step and no prerendered route table to keep in sync.
// `ssr = false` keeps `window`/`WebSocket` available at module scope, and
// `fallback` in vite.config.ts handles deep links.
export const prerender = false;
export const ssr = false;
