<script lang="ts">
	/**
	 * The theme picker and the same transcript under two palettes. Every colour
	 * is a token, which is the point: switching a theme changes this card too.
	 */
	import MockFrame from './MockFrame.svelte';
</script>

<MockFrame label="/theme" bleed>
	<div class="palettes">
		<div class="swatch">
			<span class="name">alnair-night</span>
			<span class="chips">
				<i style:background="var(--accent-assistant)"></i>
				<i style:background="var(--accent-system)"></i>
				<i style:background="var(--accent-success)"></i>
				<i style:background="var(--accent-plan)"></i>
				<i style:background="var(--olive)"></i>
			</span>
			<span class="active" aria-hidden="true">●</span>
		</div>

		<div class="swatch alt">
			<span class="name">paper</span>
			<span class="chips">
				<i style:background="#7d4bc6"></i>
				<i style:background="#2f64d2"></i>
				<i style:background="#378e23"></i>
				<i style:background="#a8780a"></i>
				<i style:background="#7a8c3e"></i>
			</span>
		</div>
	</div>

	<div class="preview">
		<span class="k">&#9670;</span>
		<span class="thinking">Thinking</span>
		<span class="tool">Bash</span>
		<span class="ok">✓</span>
		<span class="text">cargo test --workspace</span>
	</div>
</MockFrame>

<style>
	.palettes {
		display: grid;
		gap: 0.25rem;
		padding: 0.375rem 0.5rem 0.25rem;
	}

	.swatch {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.375rem;
		border-radius: 0.25rem;
		font-size: 0.625rem;
	}

	.swatch:first-child {
		background: color-mix(in srgb, var(--olive) 9%, transparent);
	}

	.name {
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.alt .name {
		color: var(--ink-secondary);
	}

	.chips {
		display: inline-flex;
		gap: 0.1875rem;
	}

	.chips i {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 999px;
	}

	.active {
		color: var(--olive);
		font-size: 0.4375rem;
	}

	.preview {
		display: flex;
		align-items: baseline;
		gap: 0.3125rem;
		margin-top: 0.25rem;
		padding: 0.3125rem 0.6875rem 0.4375rem;
		border-top: 1px solid var(--line);
		font-size: 0.625rem;
	}

	.k {
		color: var(--accent-assistant);
	}

	.thinking {
		color: var(--accent-assistant);
	}

	.tool {
		margin-left: 0.375rem;
		color: var(--accent-tool);
	}

	.ok {
		color: var(--accent-success);
	}

	.text {
		color: var(--ink-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
