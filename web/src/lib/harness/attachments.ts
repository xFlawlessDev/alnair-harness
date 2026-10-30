import type { ContentBlock } from './types/acp.js';

/**
 * Attachments the composer holds before a prompt is sent.
 *
 * Two kinds, because the wire has two ways to carry them and they mean
 * different things to the agent:
 *
 * - **`image`** becomes an ACP `ImageContent` block. The agent feeds it to the
 *   model as a picture, which is what a pasted screenshot wants.
 * - **`text`** becomes a `Resource` block with a `file://` URI and the text
 *   inline. The agent renders it as `<file_contents path="…">…</file_contents>`
 *   (or writes it to `pasted/` when it is too big for the prompt), which is
 *   exactly the TUI's "paste a long log" path.
 *
 * A one-line string is not an attachment: it stays in the textarea, because a
 * `file_contents` block for ten characters is noise the model has to read.
 */
export interface Attachment {
	/** Stable within one draft; the chip's key and the removal target. */
	id: string;
	kind: 'image' | 'text';
	/** What the chip shows: the pasted file's name, or `pasted-text-1`. */
	name: string;
	/** Image: a data URL for the chip thumbnail. Text: unused. */
	preview?: string;
	/** Image: the base64 payload with no `data:` prefix. Text: the text. */
	data: string;
	/** Image only, e.g. `image/png`. */
	mime?: string;
	bytes: number;
}

/** A paste shorter than this stays in the textarea as plain text. */
export const PASTE_AS_FILE_CHARS = 1_200;

/** Lines past this count are also "this is a file, not a sentence". */
export const PASTE_AS_FILE_LINES = 24;

/**
 * A pasted image is always an attachment, past this size floor.
 *
 * The floor exists because some browsers hand over a 0-byte or 1-pixel image
 * for a copy that carried no raster at all; attaching that would send the
 * model a blank picture and hide the fact that the paste was empty.
 */
export const MIN_IMAGE_BYTES = 64;

/**
 * Whether a plain-text paste should become an attachment instead of text.
 *
 * The TUI's rule, in browser terms: a paste that is obviously a chunk of a
 * FILE (long, or many lines) becomes a `file_contents` block; anything
 * shorter is just what the reader is typing. Splitting on both makes the
 * thresholds independent — a 300-line stack trace and a 3,000-character
 * minified JSON line are both files, and neither alone is enough to say so.
 */
export function shouldAttachText(text: string): boolean {
	if (text.length >= PASTE_AS_FILE_CHARS) return true;
	let lines = 1;
	for (const char of text) if (char === '\n') lines += 1;
	return lines >= PASTE_AS_FILE_LINES && text.trim().length > 0;
}

/** `paste-1`, `paste-2`, … — never colliding with a live attachment id. */
export function nextAttachmentId(existing: Attachment[]): string {
	let index = existing.length + 1;
	while (existing.some((attachment) => attachment.id === `paste-${index}`)) index += 1;
	return `paste-${index}`;
}

/** `pasted-text-2.log`: a name a reader can tell apart from their own files. */
export function pastedName(existing: Attachment[]): string {
	const used = new Set(existing.map((attachment) => attachment.name));
	let index = existing.length + 1;
	while (used.has(`pasted-text-${index}`)) index += 1;
	return `pasted-text-${index}`;
}

/**
 * The prompt blocks for one send.
 *
 * Order matters twice. The text block goes FIRST so the agent's
 * `<user_query>` is the paragraph the model reads before the attachments, and
 * images follow the text so a `[Image #1]` reference in the sentence points at
 * a picture that has already arrived.
 */
export function promptBlocks(text: string, attachments: Attachment[]): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	if (text.trim().length > 0) blocks.push({ type: 'text', text });
	for (const attachment of attachments) {
		if (attachment.kind === 'image') {
			blocks.push({
				type: 'image',
				data: attachment.data,
				mimeType: attachment.mime ?? 'image/png',
				// The agent keys its `<file_contents>` render off this URI, and a
				// pasted picture has no path of its own — so it names the chip.
				uri: `pasted://${attachment.name}`
			});
			continue;
		}
		blocks.push({
			type: 'resource',
			resource: {
				uri: `file://pasted/${attachment.name}`,
				mimeType: 'text/plain',
				text: attachment.data
			}
		});
	}
	return blocks;
}

/** Read a `File` (a paste or a drop) into an attachment. */
export async function attachmentFromFile(file: File): Promise<Attachment | undefined> {
	const isImage = file.type.startsWith('image/');
	if (isImage) {
		const buffer = await file.arrayBuffer();
		if (buffer.byteLength < MIN_IMAGE_BYTES) return undefined;
		return {
			id: 'file',
			kind: 'image',
			name: file.name || 'pasted-image',
			preview: URL.createObjectURL(file),
			data: base64FromBytes(new Uint8Array(buffer)),
			mime: file.type || 'image/png',
			bytes: buffer.byteLength
		};
	}
	const text = await file.text();
	if (!text.trim()) return undefined;
	return {
		id: 'file',
		kind: 'text',
		name: file.name || 'pasted-text',
		data: text,
		bytes: file.size
	};
}

/**
 * Base64 without a `data:` prefix, which is what ACP's `ImageContent` wants.
 *
 * `btoa` is byte-oriented, so the array is chunked: spreading a 4 MB image
 * into one `String.fromCharCode` call overflows the argument limit on some
 * engines and throws.
 */
export function base64FromBytes(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let index = 0; index < bytes.length; index += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
	}
	return btoa(binary);
}

/** What a chip says about an attachment, beside its name. */
export function attachmentMeta(attachment: Attachment): string {
	if (attachment.kind === 'image') return attachment.mime ?? 'image';
	const lines = attachment.data.split('\n').length;
	return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
