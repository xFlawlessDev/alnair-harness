<script lang="ts">
	import CodeIcon from '@lucide/svelte/icons/code';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import MaximizeIcon from '@lucide/svelte/icons/maximize-2';
	import MinimizeIcon from '@lucide/svelte/icons/minimize-2';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { cn } from '#lib/utils.js';

	/**
	 * The bottom drawer: a workspace editor and a real terminal, as two tabs.
	 *
	 * This is the shape VS Code uses — a panel docked under the work, opened
	 * with one chord, resizable, closable — and the shape `alnair-ai`'s
	 * `ChatEditorDrawer` / `ChatTerminalDrawer` use for the same reason: an
	 * editor beside a conversation needs width, not a 320px rail, and a shell
	 * needs a whole row of it.
	 *
	 * The drawer OWNS the layout (height, drag, fullscreen) and nothing else.
	 * Both tabs are supplied as snippets so this component never learns what a
	 * file or a PTY is; that is what keeps it reusable and the panes testable.
	 */
	let {
		open = $bindable(false),
		tab = $bindable('terminal'),
		height = $bindable(320),
		terminal,
		editor,
		badge
	}: {
		open?: boolean;
		/** Which tab is in front. */
		tab?: 'terminal' | 'editor';
		/** Panel height in px; the drag handle writes to it. */
		height?: number;
		/** The terminal pane, rendered only while its tab is in front. */
		terminal: import('svelte').Snippet;
		/** The editor pane. */
		editor: import('svelte').Snippet;
		/** Optional count shown beside a tab, e.g. open files. */
		badge?: { terminal?: number; editor?: number };
	} = $props();

	/** The drawer's own node, so fullscreen can be requested on it. */
	let panel: HTMLDivElement | null = $state(null);
	let fullscreen = $state(false);
	let dragging = $state(false);

	/** Floor and ceiling for the drag, in px. */
	const MIN_HEIGHT = 140;
	const MAX_HEIGHT = 900;

	/**
	 * Drag the top edge to resize.
	 *
	 * Pointer capture rather than document listeners: the pointer leaves the
	 * 4px handle almost immediately, and an uncaptured drag would stop the
	 * moment it did.
	 */
	function startDrag(event: PointerEvent) {
		event.preventDefault();
		dragging = true;
		const startY = event.clientY;
		const startHeight = height;
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);

		const move = (moveEvent: PointerEvent) => {
			// Dragging UP grows the panel, so the delta is inverted.
			const next = startHeight + (startY - moveEvent.clientY);
			height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next));
		};
		const end = () => {
			dragging = false;
			target.releasePointerCapture(event.pointerId);
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', end);
			target.removeEventListener('pointercancel', end);
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', end);
		target.addEventListener('pointercancel', end);
	}

	async function toggleFullscreen() {
		if (!panel) return;
		if (document.fullscreenElement === panel) {
			await document.exitFullscreen();
			return;
		}
		await panel.requestFullscreen();
	}

	$effect(() => {
		const sync = () => (fullscreen = document.fullscreenElement === panel);
		document.addEventListener('fullscreenchange', sync);
		return () => document.removeEventListener('fullscreenchange', sync);
	});
</script>

{#if open}
	<div
		bind:this={panel}
		class="drawer rule-t flex shrink-0 flex-col bg-paper-raised"
		style:height={fullscreen ? '100dvh' : `${height}px`}
		data-slot="bottom-drawer"
	>
		<!-- The grab strip. 4px tall, full width, with a visible line on hover. -->
		<div
			class={cn(
				'group/grab flex h-1 shrink-0 cursor-row-resize items-center justify-center',
				dragging && 'bg-olive/20'
			)}
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize the panel"
			aria-valuenow={height}
			aria-valuemin={MIN_HEIGHT}
			aria-valuemax={MAX_HEIGHT}
			tabindex="-1"
			onpointerdown={startDrag}
		>
			<span
				class="h-px w-8 rounded-full bg-line-strong transition-colors group-hover/grab:bg-olive/60"
			></span>
		</div>

		<div class="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
			<button
				type="button"
				class={cn(
					'flex h-6 items-center gap-1.5 rounded px-2 text-[11px] transition-colors',
					tab === 'terminal'
						? 'bg-paper-card text-ink'
						: 'text-ink-tertiary hover:bg-paper-card/60 hover:text-ink-secondary'
				)}
				aria-selected={tab === 'terminal'}
				role="tab"
				onclick={() => (tab = 'terminal')}
			>
				<SquareTerminalIcon class="size-3" />
				Terminal
				{#if badge?.terminal}
					<span class="tabular font-mono text-[9.5px] text-ink-tertiary/70">
						{badge.terminal}
					</span>
				{/if}
			</button>

			<button
				type="button"
				class={cn(
					'flex h-6 items-center gap-1.5 rounded px-2 text-[11px] transition-colors',
					tab === 'editor'
						? 'bg-paper-card text-ink'
						: 'text-ink-tertiary hover:bg-paper-card/60 hover:text-ink-secondary'
				)}
				aria-selected={tab === 'editor'}
				role="tab"
				onclick={() => (tab = 'editor')}
			>
				<CodeIcon class="size-3" />
				Editor
				{#if badge?.editor}
					<span class="tabular font-mono text-[9.5px] text-ink-tertiary/70">{badge.editor}</span>
				{/if}
			</button>

			<div class="ml-auto flex shrink-0 items-center gap-0.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-xs"
								class="text-ink-tertiary hover:text-ink"
								aria-label={fullscreen ? 'Exit full screen' : 'Full screen panel'}
								onclick={() => void toggleFullscreen()}
							>
								{#if fullscreen}
									<MinimizeIcon />
								{:else}
									<MaximizeIcon />
								{/if}
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>
						<p>{fullscreen ? 'Exit full screen' : 'Full screen panel'}</p>
					</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-xs"
								class="text-ink-tertiary hover:text-ink"
								aria-label="Collapse the panel"
								onclick={() => (open = false)}
							>
								<ChevronDownIcon />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>Collapse</p></Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-xs"
								class="text-ink-tertiary hover:text-ink"
								aria-label="Close the panel"
								onclick={() => (open = false)}
							>
								<XIcon />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>Close</p></Tooltip.Content>
				</Tooltip.Root>
			</div>
		</div>

		<!--
			Both panes stay MOUNTED; only one is shown.
			
			Switching tabs used to swap the rendered snippet, which unmounted the
			other pane: the terminal's teardown closed its PTY (killing the
			shell) and the editor lost every open tab and unsaved buffer. VS Code
			keeps both alive and hides one, and so does this. `hidden` sets
			`display:none`, which is what makes the hidden pane stop costing
			paint — and both panes take a `visible` prop so the one being shown
			can re-measure itself (Monaco and xterm both cache a size).
		-->
		<div class={['flex min-h-0 flex-1 flex-col', tab === 'terminal' ? '' : 'hidden']}>
			{@render terminal()}
		</div>
		<div class={['flex min-h-0 flex-1 flex-col', tab === 'editor' ? '' : 'hidden']}>
			{@render editor()}
		</div>
	</div>
{/if}
