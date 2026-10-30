/**
 * Clipboard and file-save, for a page that is not always in a secure context.
 *
 * `navigator.clipboard` exists only on HTTPS or `localhost`. `alnair web` binds
 * `127.0.0.1` by default, so the happy path works — but the moment the page is
 * opened from another machine (`--bind 0.0.0.0`, a port-forward, a container
 * host) the property is `undefined`. Reading `.writeText` off it throws a
 * `TypeError` synchronously, inside the click handler, before any `.catch`
 * could run: the button did nothing at all and the caller's "copied" flag never
 * flipped. That is the whole of the "copy does not work" report.
 *
 * So every copy goes through `copyText`, which:
 *
 * 1. tries the async Clipboard API when it is actually there,
 * 2. falls back to a hidden textarea plus `document.execCommand('copy')` — the
 *    pre-2018 technique, still supported everywhere and not gated on a secure
 *    context,
 * 3. reports whether it worked, so a caller can say so instead of lying.
 *
 * Nothing here throws. A copy is a convenience; a failed one must be a toast,
 * not an unhandled rejection in the console.
 */

/** Whether the async Clipboard API is usable in this document. */
export function hasClipboardApi(): boolean {
	return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
}

/**
 * Copy `text`, returning whether it landed.
 *
 * `false` means the browser refused both paths (a permission prompt denied, a
 * document without focus, an embedded webview). The caller should say so.
 */
export async function copyText(text: string): Promise<boolean> {
	if (!text) return false;

	if (hasClipboardApi()) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denied, or the document lost focus mid-call. Fall
			// through to the legacy path rather than giving up.
		}
	}

	return copyTextLegacy(text);
}

/**
 * `execCommand('copy')` over a hidden textarea.
 *
 * Three details make it work rather than silently no-op:
 *
 * - The textarea must be in the document and focusable; `readonly` plus
 *   `position:fixed` keeps it off-screen without scrolling the page to it.
 * - The previous selection is saved and restored, or copying from a code block
 *   would leave the reader's own selection collapsed.
 * - The element is removed in a `finally`, because a throw here must not leave
 *   an invisible textarea parked over the page.
 */
function copyTextLegacy(text: string): boolean {
	if (typeof document === 'undefined') return false;

	const previous = document.activeElement as HTMLElement | null;
	const selection = document.getSelection();
	const ranges: Range[] = [];
	if (selection) {
		for (let index = 0; index < selection.rangeCount; index += 1) {
			ranges.push(selection.getRangeAt(index));
		}
	}

	const node = document.createElement('textarea');
	node.value = text;
	node.setAttribute('readonly', '');
	node.setAttribute('aria-hidden', 'true');
	node.style.position = 'fixed';
	node.style.top = '0';
	node.style.left = '0';
	node.style.width = '1px';
	node.style.height = '1px';
	node.style.padding = '0';
	node.style.border = 'none';
	node.style.opacity = '0';
	node.style.pointerEvents = 'none';
	document.body.appendChild(node);

	let copied = false;
	try {
		node.select();
		node.setSelectionRange(0, text.length);
		copied = document.execCommand('copy');
	} catch {
		// `execCommand` throws in a document that is not focused, and in a
		// webview that has removed the command. Both mean "did not copy".
	} finally {
		node.remove();
		// Restore the reader's selection and focus: the copy is an action
		// beside their text, not a reason to move their caret.
		if (selection) {
			selection.removeAllRanges();
			for (const range of ranges) selection.addRange(range);
		}
		previous?.focus?.();
	}
	return copied;
}

/**
 * Save `text` as a file, through a blob URL.
 *
 * There is no download feature to fix, so this is the one that exists: the
 * reply as Markdown, a command's output as text, a patch as `.diff`. It is the
 * browser-native path — an `<a download>` click — because the alternative (a
 * server endpoint) would need an HTTP surface for content the page already
 * holds.
 *
 * `revokeObjectURL` is deferred by a tick: revoking in the same task as the
 * click cancels the download in some browsers.
 */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
	if (typeof document === 'undefined') return;
	const blob = new Blob([text], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.rel = 'noopener';
	link.style.display = 'none';
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A filename that survives every OS: no separators, no reserved characters.
 *
 * Built from a whitelist rather than a blacklist. The characters every OS
 * refuses (`\ / : * ? " < > |`) are only the obvious half — Windows also
 * rejects the C0 control range, and a name of nothing but separators reduces to
 * punctuation. Keeping the characters that are safe is one rule that cannot be
 * incomplete.
 */
export function safeFilename(name: string, fallback = 'alnair'): string {
	const cleaned = name
		// Everything printable except the separators and reserved characters.
		.replace(/[^\p{L}\p{N}._\- ]+/gu, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[.\s-]+|[.\s-]+$/g, '')
		.slice(0, 120);
	return cleaned || fallback;
}
