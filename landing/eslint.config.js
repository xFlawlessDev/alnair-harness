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
			// TypeScript already reports undefined identifiers, and the base rule
			// misreads type-only names as globals.
			'no-undef': 'off',
			// `{#each}` blocks over dictionary arrays are static, but a keyed
			// block elsewhere is not; leave the decision to the author.
			'svelte/require-each-key': 'off'
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
			// This rule flags every `new Map()` / `new Set()` / `new Date()`,
			// including the throwaway ones a `$derived` body or an effect builds on
			// each run. Those are not shared state, so making them reactive would
			// add subscription bookkeeping for nothing — the marks in question are
			// plain function-local bookkeeping.
			'svelte/prefer-svelte-reactivity': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			// Every link on this page is either an in-page fragment (`#graph`) or
			// an absolute external URL, and the whole site is prerendered at the
			// domain root — there is no `paths.base` for `resolve()` to prepend.
			// The rule exists to catch links that break under a base path; here it
			// only flags links that cannot.
			'svelte/no-navigation-without-resolve': 'off',
			// One deliberate use: `DocPage` renders markdown that `render_doc`
			// generated from this repository's own user guide. That renderer
			// escapes text itself and has no raw-HTML path, and the files are
			// not user-supplied — which is exactly the condition the rule exists
			// to make someone state.
			'svelte/no-at-html-tags': 'off'
		}
	},
	{
		// The markdown pipeline is the only place raw HTML is assembled.
		files: ['src/lib/docs/**'],
		rules: { 'svelte/no-at-html-tags': 'off' }
	}
);
