<script lang="ts">
	import Section from './Section.svelte';
	import InstallCommand from './InstallCommand.svelte';
	import CopyButton from './CopyButton.svelte';
	import Rich from './Rich.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy, sourceUrl }: { copy: SiteCopy; sourceUrl: string } = $props();

	const rest = $derived([
		{ ...copy.install.steps[1], command: copy.install.connect },
		{ ...copy.install.steps[2], command: copy.install.go }
	]);
</script>

<section class="band" id="install">
	<div class="shell">
		<Section
			id="install-heading"
			eyebrow={copy.install.eyebrow}
			title={copy.install.title}
			lede={copy.install.lede}
		/>

		<div class="steps" use:reveal>
			<div class="step wide">
				<div class="step-head">
					<span class="num" aria-hidden="true">1</span>
					<div>
						<h3>{copy.install.steps[0].label}</h3>
						<p><Rich text={copy.install.steps[0].detail} /></p>
					</div>
				</div>

				<InstallCommand {copy} />

				<ul class="notes">
					{#each copy.install.notes as note (note)}
						<li><Rich text={note} /></li>
					{/each}
				</ul>
			</div>

			{#each rest as step, index (step.label)}
				<div class="step">
					<div class="step-head">
						<span class="num" aria-hidden="true">{index + 2}</span>
						<div>
							<h3>{step.label}</h3>
							<p><Rich text={step.detail} /></p>
						</div>
					</div>

					<div class="cmd-row">
						<code>{step.command}</code>
						<CopyButton
							text={step.command}
							label={copy.install.copy}
							copiedLabel={copy.install.copied}
						/>
					</div>
				</div>
			{/each}
		</div>

		<p class="build">
			{copy.install.buildNote}
			<a href={sourceUrl} rel="noreferrer">{copy.install.buildLink}</a>
		</p>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
	}

	.steps {
		display: grid;
		gap: 1px;
		border: 1px solid var(--line);
		border-radius: var(--radius-panel);
		background: var(--line);
		overflow: hidden;
	}

	.step {
		display: grid;
		gap: 1.125rem;
		padding: 1.5rem;
		background: var(--paper-raised);
		align-content: start;
	}

	.step-head {
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr);
		gap: 0.75rem;
	}

	.num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--olive);
	}

	h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ink);
	}

	.step-head p {
		margin: 0.3125rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}

	.notes {
		display: grid;
		gap: 0.3125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.notes li {
		position: relative;
		padding-left: 0.875rem;
		font-size: 0.75rem;
		line-height: 1.65;
		color: var(--ink-tertiary);
	}

	.notes li::before {
		content: '·';
		position: absolute;
		left: 0.125rem;
		color: var(--olive);
	}

	.cmd-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.375rem 0.375rem 0.875rem;
		border: 1px solid var(--line);
		border-radius: 0.625rem;
		background: var(--paper);
	}

	.cmd-row code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--ink);
		white-space: nowrap;
		scrollbar-width: none;
	}

	.cmd-row code::-webkit-scrollbar {
		display: none;
	}

	.build {
		margin: 1.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--ink-tertiary);
	}

	.build a {
		color: var(--ink-secondary);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.build a:hover {
		color: var(--ink);
	}

	@media (min-width: 960px) {
		.band {
			padding-block: 6.5rem;
		}

		.steps {
			grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
			grid-template-rows: auto auto;
		}

		.step.wide {
			grid-row: span 2;
		}

		.step {
			padding: 1.75rem;
		}
	}
</style>
