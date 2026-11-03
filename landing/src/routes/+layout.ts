// The landing page is fully static: every route is prerendered into its own
// HTML document, which is what lets Cloudflare serve it with no runtime and
// what gives each language a real URL to index.
export const prerender = true;
export const trailingSlash = 'always';
