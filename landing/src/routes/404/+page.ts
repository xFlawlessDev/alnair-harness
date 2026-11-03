/**
 * Prerendered `404.html`, the document a static host serves for an unknown URL.
 *
 * Cloudflare looks for `404.html` at the root and returns it with a 404 status
 * for any path it cannot find. This route renders real content and writes it to
 * the build, which the sitemap step then publishes as `404.html`.
 *
 * It deliberately does not throw from `load`: a thrown 404 makes the prerenderer
 * drop the route, so no document is written at all. The page is an ordinary
 * route whose only special property is `noindex`. The status the host returns
 * comes from the host, not from this file.
 */
export const prerender = true;
