import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
	]
});
