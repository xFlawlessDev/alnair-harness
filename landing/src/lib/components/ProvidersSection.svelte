<script lang="ts">
	import Section from './Section.svelte';
	import CopyButton from './CopyButton.svelte';
	import Rich from './Rich.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();
</script>

<section class="band" id="providers">
	<div class="shell">
		<Section
			id="providers-heading"
			eyebrow={copy.providers.eyebrow}
			title={copy.providers.title}
			lede={copy.providers.lede}
		/>

		<div class="columns">
			<div class="panel" use:reveal>
				<div class="panel-head">
					<h3>{copy.providers.signIn}</h3>
					<p>{copy.providers.signInNote}</p>
				</div>

				<ul class="rows">
					{#each copy.providers.rows as row (row.id)}
						<li>
							<span class="name">{row.name}</span>
							<span class="method">{row.method}</span>
							<code class="id">{row.id}</code>
						</li>
					{/each}
				</ul>
			</div>

			<div class="right">
				<div class="panel" use:reveal={{ delay: 70 }}>
					<div class="panel-head">
						<h3>{copy.providers.apiKeys}</h3>
						<p><Rich text={copy.providers.apiKeysNote} /></p>
					</div>

					<ul class="keys">
						{#each copy.providers.keys as key (key)}
							<li>{key}</li>
						{/each}
					</ul>
				</div>

				<div class="custom" use:reveal={{ delay: 110 }}>
					<h3>{copy.providers.customTitle}</h3>
					<p><Rich text={copy.providers.customBody} /></p>

					<div class="code">
						<div class="code-head">
							<span>{copy.providers.customFile}</span>
							<CopyButton
								text={copy.providers.customCode}
								label={copy.install.copy}
								copiedLabel={copy.providers.copied}
							/>
						</div>
						<pre>{copy.providers.customCode}</pre>
					</div>
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
		background: var(--paper-raised);
	}

	.columns {
		display: grid;
		gap: 1.25rem;
		align-items: start;
	}

	.panel {
		border: 1px solid var(--line);
		border-radius: var(--radius-panel);
		background: var(--paper);
		overflow: hidden;
	}

	.panel-head {
		padding: 1.375rem 1.375rem 1.125rem;
		border-bottom: 1px solid var(--line);
	}

	.panel-head h3 {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--ink);
	}

	.panel-head p {
		margin: 0.4375rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}

	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rows li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.375rem 1rem;
		padding: 0.75rem 1.375rem;
		border-bottom: 1px solid var(--line);
	}

	.rows li:last-child {
		border-bottom: 0;
	}

	.rows .name {
		font-size: 0.875rem;
		color: var(--ink);
	}

	.rows .method {
		font-size: 0.75rem;
		color: var(--ink-tertiary);
		align-self: center;
	}

	.rows .id {
		grid-column: 1 / -1;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-tertiary);
	}

	.keys {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4375rem;
		margin: 0;
		padding: 1.25rem 1.375rem 1.5rem;
		list-style: none;
	}

	.keys li {
		padding: 0.25rem 0.5625rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-secondary);
		background: var(--paper-card);
	}

	.right {
		display: grid;
		gap: 1.25rem;
		align-content: start;
	}

	.custom {
		display: grid;
		gap: 1rem;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-panel);
		background: var(--paper);
	}

	.custom h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ink);
	}

	.custom p {
		margin: -0.375rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.65;
		color: var(--ink-secondary);
	}

	.code {
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		background: var(--code-surface);
		overflow: hidden;
	}

	.code-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.375rem 0.5rem 0.375rem 0.875rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper-inset);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-tertiary);
	}

	pre {
		margin: 0;
		padding: 1rem 1.125rem 1.25rem;
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.7;
		color: var(--ink-secondary);
	}

	@media (min-width: 900px) {
		.band {
			padding-block: 6.5rem;
		}

		.columns {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 1.25rem;
		}
	}
</style>
