import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		rules: {
			// This rule flags every `new Map()` / `new Set()` / `new Date()`, including
			// the throwaway ones a `$derived` body builds on each run. Those are not
			// shared state, and SvelteMap/SvelteSet would make them reactive for no
			// reason; the store's own collections stay plain on purpose.
			'svelte/prefer-svelte-reactivity': 'off',
			// Omitting a key by destructuring is the idiomatic way to build a new
			// object without it, and the removed binding is intentionally unnamed.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		// Vendored shadcn-svelte components: an anchor may point at any URL the
		// caller passes, and `resolve()` only applies to in-app routes.
		files: ['src/lib/components/ui/**'],
		rules: { 'svelte/no-navigation-without-resolve': 'off' }
	}
);
