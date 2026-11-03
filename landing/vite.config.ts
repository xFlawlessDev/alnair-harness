import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * The landing page is a fully prerendered static site: one HTML document per
 * language, no server runtime, nothing to keep warm. That is what makes it a
 * plain directory upload to Cloudflare Pages (or Workers static assets).
 */
export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ strict: true })
		})
	],

	resolve: {
		alias: {
			$lib: path.resolve(import.meta.dirname, 'src/lib')
		}
	},

	define: {
		/**
		 * The docs pipeline reads the user guide out of the app's source tree.
		 *
		 * It has to be absolute and baked in at build time: the prerender bundle
		 * runs from `.svelte-kit/output`, where a relative path back to the repo
		 * root resolves inside `.svelte-kit` instead. A string literal here keeps
		 * `node:fs` reachable from the build script and from nowhere else — the
		 * client bundle never imports the module that uses it.
		 */
		__DOCS_ROOT__: JSON.stringify(path.resolve(import.meta.dirname, '..'))
	}
});
