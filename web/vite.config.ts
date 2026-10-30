import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Where a running `alnair web` listens, when the dev server proxies to it.
 *
 * Overridable so a reader can point HMR at a server started with `--bind
 * 127.0.0.1:0` (which prints its own port).
 */
const BACKEND = process.env.ALNAIR_WEB_BACKEND ?? 'http://127.0.0.1:2420';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// The build is a static SPA that `alnair web` embeds in the binary.
			// `fallback` is what makes an extensionless deep link resolve to the
			// shell; the Rust side has one rule for every path (see docs/WEB.md).
			adapter: adapter({ fallback: 'index.html' })
		})
	],

	/**
	 * HMR proxies the two things that are not part of the SPA.
	 *
	 * Without this, `npm run dev` serves only static files: `/api/*` answers
	 * 404 from Vite and `/ws` never upgrades, so every server-side action in
	 * the page — adding a workspace, the folder picker, the socket itself —
	 * fails in dev while working in the embedded build. `ws: true` is what
	 * makes the upgrade survive the hop.
	 *
	 * The Rust gate accepts the dev origin only under `cfg!(debug_assertions)`,
	 * so this is a development-only path by construction.
	 */
	server: {
		proxy: {
			'/api': { target: BACKEND, changeOrigin: false },
			'/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true, changeOrigin: false }
		}
	}
});
