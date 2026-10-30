import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, downloadText, hasClipboardApi, safeFilename } from './clipboard.js';

/**
 * The clipboard paths, as far as a DOM-less runner can exercise them.
 *
 * `copyText` is the fix for "copy does nothing": `navigator.clipboard` is
 * `undefined` outside a secure context, so the old `navigator.clipboard
 * .writeText(...)` threw a TypeError inside the click handler before any
 * `.catch` could run. These tests pin both paths.
 */

const originalNavigator = globalThis.navigator;

function stubClipboard(writeText: (value: string) => Promise<void>) {
	Object.defineProperty(globalThis, 'navigator', {
		value: { clipboard: { writeText } },
		configurable: true,
		writable: true
	});
}

function removeClipboard() {
	Object.defineProperty(globalThis, 'navigator', {
		value: { clipboard: undefined },
		configurable: true,
		writable: true
	});
}

afterEach(() => {
	Object.defineProperty(globalThis, 'navigator', {
		value: originalNavigator,
		configurable: true,
		writable: true
	});
	vi.restoreAllMocks();
});

describe('hasClipboardApi', () => {
	it('is true when writeText exists', () => {
		stubClipboard(async () => {});
		expect(hasClipboardApi()).toBe(true);
	});

	it('is false when the property is missing', () => {
		// The secure-context case: the object itself is undefined.
		removeClipboard();
		expect(hasClipboardApi()).toBe(false);
	});

	it('is false when clipboard exists but writeText does not', () => {
		Object.defineProperty(globalThis, 'navigator', {
			value: { clipboard: {} },
			configurable: true,
			writable: true
		});
		expect(hasClipboardApi()).toBe(false);
	});
});

describe('copyText', () => {
	it('uses the Clipboard API when it is available', async () => {
		const writeText = vi.fn(async () => {});
		stubClipboard(writeText);
		expect(await copyText('hello')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('hello');
	});

	it('does not throw when the Clipboard API is missing', async () => {
		// This is the bug: the old call threw a TypeError synchronously. A
		// rejection is fine; a throw is not.
		removeClipboard();
		await expect(copyText('hello')).resolves.toBe(false);
	});

	it('falls back to the legacy path when the API rejects', async () => {
		stubClipboard(async () => {
			throw new Error('denied');
		});
		// No document in this runner, so the fallback reports failure rather
		// than throwing — which is what the caller needs to show a message.
		await expect(copyText('hello')).resolves.toBe(false);
	});

	it('refuses an empty string without touching the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		stubClipboard(writeText);
		expect(await copyText('')).toBe(false);
		expect(writeText).not.toHaveBeenCalled();
	});
});

describe('safeFilename', () => {
	it('strips every character an OS refuses', () => {
		expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
	});

	it('strips control characters', () => {
		expect(safeFilename('a\u0000b\u001fc')).toBe('a-b-c');
	});

	it('trims leading and trailing dots and spaces', () => {
		expect(safeFilename('  .hidden.  ')).toBe('hidden');
	});

	it('collapses a run of replacements instead of leaving dashes', () => {
		// `///` would otherwise become `---`, which is a name no reader wants
		// and which `slice` alone would happily return.
		expect(safeFilename('a///b')).toBe('a-b');
	});

	it('falls back when nothing usable is left', () => {
		expect(safeFilename('///', 'reply')).toBe('reply');
		expect(safeFilename('')).toBe('alnair');
	});

	it('caps the length', () => {
		expect(safeFilename('a'.repeat(500)).length).toBe(120);
	});

	it('keeps an ordinary name intact', () => {
		expect(safeFilename('reply-kimi-k2.md')).toBe('reply-kimi-k2.md');
	});
});

describe('downloadText', () => {
	let clicks: string[] = [];
	let created: Blob[] = [];

	beforeEach(() => {
		clicks = [];
		created = [];
		// A minimal DOM: the anchor click is the download, and the blob is the
		// payload. Asserting on those two is enough to prove the path works
		// without a browser.
		const body = {
			appendChild: (node: { href?: string; download?: string }) => {
				if (node.download) clicks.push(node.download);
				return node;
			},
			removeChild: () => {},
			remove: () => {}
		};
		(globalThis as { document?: unknown }).document = {
			body,
			createElement: () => ({
				style: {},
				click() {},
				remove() {}
			})
		};
		(globalThis as { URL?: unknown }).URL = Object.assign(URL, {
			createObjectURL: (blob: Blob) => {
				created.push(blob);
				return 'blob:test';
			},
			revokeObjectURL: () => {}
		});
	});

	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	it('clicks a link named after the requested file', () => {
		downloadText('reply.md', '# hi', 'text/markdown');
		expect(clicks).toContain('reply.md');
	});

	it('puts the text in the blob, with the mime type', async () => {
		downloadText('out.txt', 'body', 'text/plain');
		expect(created).toHaveLength(1);
		expect(created[0].type).toContain('text/plain');
		expect(await created[0].text()).toBe('body');
	});

	it('does not throw without a document', () => {
		delete (globalThis as { document?: unknown }).document;
		expect(() => downloadText('x.txt', 'y')).not.toThrow();
	});
});
