<script lang="ts">
	/**
	 * A skill as the model sees it: YAML frontmatter with the `description` it
	 * matches against, then the body it loads on demand.
	 */
	import MockFrame from './MockFrame.svelte';
</script>

<MockFrame label="~/.alnair/skills/review-pr/SKILL.md" bleed>
	<pre class="md"><span class="fence">---</span>
<span class="key">name</span>: <span class="str">review-pr</span>
<span class="key">description</span>: <span class="str">Read a PR diff and report</span>
  <span class="str">findings. Use when asked to review,</span>
  <span class="str">audit or check a pull request.</span>
<span class="fence">---</span>

<span class="h"># PR review</span>

<span class="p">Read the diff, then report by severity.</span>
<span class="p">Never restate the diff itself.</span></pre>
</MockFrame>

<style>
	.md {
		margin: 0;
		padding: 0.5rem 0.6875rem 0.625rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		line-height: 1.6;
		color: var(--ink-secondary);
		overflow: hidden;
	}

	.fence {
		color: var(--ink-tertiary);
		opacity: 0.7;
	}

	.key {
		color: var(--accent-system);
	}

	.str {
		color: var(--ink-secondary);
	}

	.h {
		color: var(--olive);
		font-weight: 500;
	}

	.p {
		color: var(--ink-secondary);
	}

	/* The two tones the editor gives frontmatter and body are enough; anything
	   more would make a 12-line file look like a syntax-highlighting showcase. */
</style>
