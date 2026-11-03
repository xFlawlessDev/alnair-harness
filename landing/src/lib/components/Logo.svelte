<script lang="ts">
	/**
	 * The Alnair mark, inlined on `currentColor` so it themes with the page.
	 * Paths are the source art from `web/src/lib/assets/logo-white.svg`,
	 * unchanged.
	 */
	let { size = 20, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg
	class="shrink-0 {className}"
	width={size}
	height={size}
	viewBox="0 0 1000 1000"
	fill="currentColor"
	aria-hidden="true"
>
	<path
		d="M82.85,905.68l282.23-62,305.34-67.48-50.44-112.24-67.33-150.79,78.33,100.97,229.24,310.14-856.72-.11c26.04-7.41,51.76-12.14,79.34-18.48Z"
	/>
	<polygon
		points="130.28 765.6 193.39 650.71 420.99 235.7 509.51 75.73 324.98 700.13 606.64 749.65 130.28 765.6"
	/>
	<path
		d="M879.44,797.83l-335.33-352.92-161.83,215.99c59.26-139.33,120.4-273.77,183.08-413.28,109.41,167.8,216.31,333.73,322.58,501.83l108.13,169.87c.55,2.15.84,2.87-1,1.28l-115.63-122.76Z"
	/>
</svg>
