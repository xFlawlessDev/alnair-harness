<script lang="ts">
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();

	let video: HTMLVideoElement | null = $state(null);
	let playing = $state(false);

	async function play() {
		if (!video) return;
		try {
			await video.play();
		} catch {
			// Autoplay policies can refuse a play() while the element is still
			// loading; the native controls remain available.
		}
	}
</script>

<figure class="demo" use:reveal>
	<div class="frame">
		<video
			bind:this={video}
			poster="/media/alnair-demo-poster.jpg"
			preload="none"
			playsinline
			controls
			onplay={() => (playing = true)}
			onpause={() => (playing = false)}
			onended={() => (playing = false)}
		>
			<source src="/media/alnair-demo.webm" type="video/webm" />
			<source src="/media/alnair-demo.mp4" type="video/mp4" />
		</video>

		{#if !playing}
			<button type="button" class="play" onclick={play}>
				<span class="ring" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M8 5.5v13l11-6.5-11-6.5Z" />
					</svg>
				</span>
				<span class="label">{copy.hero.play}</span>
			</button>
		{/if}
	</div>

	<figcaption>{copy.hero.demoCaption}</figcaption>
</figure>

<style>
	.demo {
		margin: 0;
	}

	.frame {
		position: relative;
		border: 1px solid var(--line);
		border-radius: var(--radius-panel);
		background: #000;
		overflow: hidden;
		box-shadow: var(--shadow);
	}

	video {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: 1112 / 580;
		background: #000;
	}

	.play {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		border: 0;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.05) 55%);
		color: #ededed;
		cursor: pointer;
	}

	.ring {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.28);
		background: rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(6px);
		transition:
			transform 0.18s ease,
			border-color 0.18s ease;
	}

	.play:hover .ring {
		transform: scale(1.06);
		border-color: var(--olive);
	}

	.ring svg {
		width: 1.25rem;
		height: 1.25rem;
		margin-left: 0.1875rem;
		fill: var(--olive);
	}

	.label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.72);
	}

	figcaption {
		margin-top: 0.875rem;
		font-size: 0.75rem;
		color: var(--ink-tertiary);
		text-align: center;
	}
</style>
