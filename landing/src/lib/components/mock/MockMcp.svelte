<script lang="ts">
	/**
	 * `alnair mcp list`: transport, tool count and connection state per server.
	 * A failed server stays listed — that is the point of the command.
	 */
	import MockFrame from './MockFrame.svelte';
	import { mcpRows, toneClass } from './data';
</script>

<MockFrame label="$ alnair mcp list" bleed>
	<ul class="list">
		{#each mcpRows as row (row.name)}
			<li>
				<span class="state {toneClass[row.state]}" aria-hidden="true">●</span>
				<span class="name">{row.name}</span>
				<span class="transport">{row.transport}</span>
				<span class="tools">{row.tools}</span>
				<span class="label {toneClass[row.state]}">{row.stateLabel}</span>
			</li>
		{/each}
	</ul>
</MockFrame>

<style>
	.list {
		margin: 0;
		padding: 0.375rem 0;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: 0.625rem minmax(0, 1fr) auto auto;
		align-items: baseline;
		column-gap: 0.5rem;
		padding: 0.25rem 0.625rem;
		font-size: 0.6563rem;
	}

	.state {
		font-size: 0.5rem;
	}

	.name {
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.transport,
	.tools {
		color: var(--ink-tertiary);
		font-size: 0.625rem;
	}

	.tools {
		min-width: 3.5rem;
		text-align: right;
	}

	.label {
		font-size: 0.625rem;
		text-align: right;
		min-width: 4rem;
	}
</style>
