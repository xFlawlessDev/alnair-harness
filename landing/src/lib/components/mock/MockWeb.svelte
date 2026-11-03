<script lang="ts">
	/**
	 * The browser view. Not a second agent: `alnair web` serves a client of the
	 * same leader the TUI is attached to, so the sample shows the same session
	 * on both sides of the split.
	 */
	import MockFrame from './MockFrame.svelte';
</script>

<MockFrame label="alnair web · 127.0.0.1:2420" bleed>
	<div class="web">
		<aside>
			<span class="group">WORKSPACES</span>
			<span class="ws active"><i></i>alnair</span>
			<span class="ws"><i></i>afterinput</span>
			<span class="group">SESSIONS</span>
			<span class="sess">fix login bug</span>
			<span class="sess dim">audit token flow</span>
		</aside>

		<div class="thread">
			<span class="who">you</span>
			<span class="q">why is the refresh path unreachable?</span>
			<span class="a"
				>Two call sites build the client directly instead of asking the authority.</span
			>
			<span class="tool"><b>Read</b> token_store.rs <em>84–131</em></span>
			<span class="tool"><b>Edit</b> token_store.rs <em>+12 −3</em></span>
		</div>
	</div>
</MockFrame>

<style>
	.web {
		display: grid;
		grid-template-columns: 5.25rem minmax(0, 1fr);
		min-height: 6.25rem;
	}

	aside {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		padding: 0.4375rem 0.375rem;
		border-right: 1px solid var(--line);
		background: var(--paper-raised);
		font-size: 0.5625rem;
	}

	.group {
		margin-top: 0.3125rem;
		color: var(--ink-tertiary);
		font-size: 0.5rem;
		letter-spacing: 0.06em;
	}

	.group:first-child {
		margin-top: 0;
	}

	.ws,
	.sess {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.1875rem;
		border-radius: 0.1875rem;
		color: var(--ink-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ws i {
		width: 0.25rem;
		height: 0.25rem;
		border-radius: 0.0625rem;
		background: var(--ink-tertiary);
		flex: none;
	}

	.ws.active {
		background: var(--paper-card);
		color: var(--ink);
	}

	.ws.active i {
		background: var(--olive);
	}

	.sess {
		color: var(--ink-secondary);
		padding-left: 0.4375rem;
	}

	.dim {
		color: var(--ink-tertiary);
	}

	.thread {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		padding: 0.4375rem 0.5625rem;
		font-size: 0.5938rem;
		line-height: 1.5;
		overflow: hidden;
	}

	.who {
		color: var(--ink-tertiary);
		font-size: 0.5rem;
		letter-spacing: 0.06em;
	}

	.q {
		color: var(--ink);
	}

	.a {
		color: var(--ink-secondary);
	}

	.tool {
		display: flex;
		align-items: baseline;
		gap: 0.25rem;
		color: var(--ink-tertiary);
		white-space: nowrap;
		overflow: hidden;
	}

	.tool b {
		font-weight: 400;
		color: var(--accent-tool);
	}

	.tool em {
		font-style: normal;
		color: var(--ink-secondary);
	}
</style>
