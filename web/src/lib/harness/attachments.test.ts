import { describe, expect, it } from 'vitest';
import {
	attachmentMeta,
	base64FromBytes,
	MIN_IMAGE_BYTES,
	nextAttachmentId,
	PASTE_AS_FILE_CHARS,
	PASTE_AS_FILE_LINES,
	pastedName,
	promptBlocks,
	shouldAttachText,
	type Attachment
} from './attachments.js';

const image = (overrides: Partial<Attachment> = {}): Attachment => ({
	id: 'paste-1',
	kind: 'image',
	name: 'shot.png',
	data: 'AAAA',
	mime: 'image/png',
	bytes: 4,
	...overrides
});

const text = (overrides: Partial<Attachment> = {}): Attachment => ({
	id: 'paste-2',
	kind: 'text',
	name: 'pasted-text-2',
	data: 'a\nb\nc',
	bytes: 5,
	...overrides
});

describe('shouldAttachText', () => {
	it('keeps a sentence in the textarea', () => {
		expect(shouldAttachText('fix the failing test in composer.svelte')).toBe(false);
	});

	it('attaches a long single line', () => {
		// Minified JSON, a one-line stack trace: length alone says "this is data".
		expect(shouldAttachText('x'.repeat(PASTE_AS_FILE_CHARS))).toBe(true);
	});

	it('attaches a multi-line paste below the character threshold', () => {
		// A 30-line stack trace is ~900 characters; it is still a file, not prose.
		const lines = Array.from(
			{ length: PASTE_AS_FILE_LINES },
			(_, index) => `at frame ${index}`
		).join('\n');
		expect(lines.length).toBeLessThan(PASTE_AS_FILE_CHARS);
		expect(shouldAttachText(lines)).toBe(true);
	});

	it('does not attach blank lines alone', () => {
		expect(shouldAttachText('\n'.repeat(PASTE_AS_FILE_LINES))).toBe(false);
	});

	it('counts a trailing newline as a line break, not as content', () => {
		const lines = Array.from(
			{ length: PASTE_AS_FILE_LINES - 1 },
			(_, index) => `line ${index}`
		).join('\n');
		expect(shouldAttachText(`${lines}\n`)).toBe(true);
	});
});

describe('nextAttachmentId', () => {
	it('starts at one', () => {
		expect(nextAttachmentId([])).toBe('paste-1');
	});

	it('never reuses a live id', () => {
		const existing = [image({ id: 'paste-1' }), image({ id: 'paste-3' })];
		// Length is 2, so the naive next id would be `paste-3` — which is taken.
		expect(nextAttachmentId(existing)).toBe('paste-4');
	});
});

describe('pastedName', () => {
	it('does not collide with a name already in the draft', () => {
		const existing = [text({ name: 'pasted-text-1' }), text({ name: 'pasted-text-2' })];
		expect(pastedName(existing)).toBe('pasted-text-3');
	});
});

describe('promptBlocks', () => {
	it('puts the text block first and the attachments after', () => {
		const blocks = promptBlocks('what is wrong here?', [image()]);
		expect(blocks.map((block) => block.type)).toEqual(['text', 'image']);
	});

	it('omits an empty text block', () => {
		// An attachment-only prompt is legitimate; an empty `text` block is not.
		expect(promptBlocks('   ', [image()]).map((block) => block.type)).toEqual(['image']);
	});

	it('sends a pasted file as a resource with its text inline', () => {
		const blocks = promptBlocks('summarise', [text()]);
		const resource = blocks[1] as Extract<(typeof blocks)[number], { type: 'resource' }>;
		expect(resource.resource.text).toBe('a\nb\nc');
		expect(resource.resource.uri).toContain('pasted-text-2');
	});

	it('gives an image a uri, because the agent keys its render off it', () => {
		const blocks = promptBlocks('look', [image()]);
		const sent = blocks[1] as Extract<(typeof blocks)[number], { type: 'image' }>;
		expect(sent.uri).toBe('pasted://shot.png');
		expect(sent.mimeType).toBe('image/png');
		expect(sent.data).toBe('AAAA');
	});

	it('defaults an image mime type when the browser reported none', () => {
		const blocks = promptBlocks('', [image({ mime: undefined })]);
		const sent = blocks[0] as Extract<(typeof blocks)[number], { type: 'image' }>;
		expect(sent.mimeType).toBe('image/png');
	});

	it('preserves order across mixed attachments', () => {
		const blocks = promptBlocks('go', [image(), text()]);
		expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'resource']);
	});

	it('is empty when there is neither text nor an attachment', () => {
		expect(promptBlocks('', [])).toEqual([]);
	});
});

describe('base64FromBytes', () => {
	it('encodes without a data: prefix', () => {
		expect(base64FromBytes(new Uint8Array([0x68, 0x69]))).toBe('aGk=');
	});

	it('survives a payload past the argument limit of String.fromCharCode', () => {
		// Spreading a multi-megabyte array into one call throws on some engines;
		// the chunked path is what makes a real screenshot work.
		const bytes = new Uint8Array(200_000).fill(0x41);
		expect(base64FromBytes(bytes).length).toBeGreaterThan(200_000);
	});

	it('round-trips through atob', () => {
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const decoded = Uint8Array.from(atob(base64FromBytes(bytes)), (char) => char.charCodeAt(0));
		expect([...decoded]).toEqual([...bytes]);
	});
});

describe('attachmentMeta', () => {
	it('names the mime type of an image', () => {
		expect(attachmentMeta(image())).toBe('image/png');
	});

	it('counts the lines of a pasted file', () => {
		expect(attachmentMeta(text())).toBe('3 lines');
	});

	it('says one line, not 1 lines', () => {
		expect(attachmentMeta(text({ data: 'single' }))).toBe('1 line');
	});
});

describe('MIN_IMAGE_BYTES', () => {
	it('is a real floor, so an empty clipboard raster is not attached', () => {
		expect(MIN_IMAGE_BYTES).toBeGreaterThan(0);
	});
});
