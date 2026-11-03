/**
 * Cross-fade a section in when it first scrolls into view.
 *
 * The attribute is added by JavaScript, never server-rendered, so a reader with
 * scripting off — or a crawler — sees every section immediately instead of a
 * page of invisible text. `prefers-reduced-motion` is handled in CSS.
 */
export function reveal(node: HTMLElement, options: { delay?: number } = {}) {
	const delay = options.delay ?? 0;
	node.dataset.reveal = 'pending';
	node.style.setProperty('--reveal-delay', `${delay}ms`);

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				node.dataset.reveal = 'shown';
				observer.disconnect();
			}
		},
		{ rootMargin: '0px 0px -12% 0px', threshold: 0.05 }
	);

	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
		}
	};
}
