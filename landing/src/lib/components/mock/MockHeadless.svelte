<script lang="ts">
	/**
	 * Headless mode: `alnair -p` prints the answer and exits, so it composes
	 * with anything — a Makefile, a CI step, a pipe.
	 */
	import MockFrame from './MockFrame.svelte';
</script>

<MockFrame label="$ alnair -p 'summarise the diff'" bleed>
	<pre class="out"><span class="cmd">The patch moves the token store behind</span>
<span class="cmd">one interface and adds a refresh path.</span>
<span class="cmd">Two call sites still bypass it.</span>

<span class="meta">exit 0 · 4.1k tokens in · 212 out · 38s</span></pre>
</MockFrame>

<style>
	.out {
		margin: 0;
		padding: 0.5rem 0.6875rem 0.625rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		line-height: 1.65;
		overflow: hidden;
	}

	.cmd {
		color: var(--ink);
	}

	.meta {
		color: var(--ink-tertiary);
		font-size: 0.5938rem;
	}
</style>
