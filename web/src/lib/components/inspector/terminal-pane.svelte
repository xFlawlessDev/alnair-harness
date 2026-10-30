<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { TerminalBridge } from '#lib/harness/session-store.svelte.js';

	/**
	 * A real terminal, in the page.
	 *
	 * The pane is an interactive PTY, not a mirror of the agent's tool output:
	 * it owns its own shell, forwards keystrokes, pastes and resizes, and
	 * replays the server's ring buffer on reopen. That is the same model the
	 * TUI's terminal pane uses, and the same one `alnair-ai`'s
	 * `ChatTerminalDrawer` uses.
	 *
	 * Three details make it work rather than merely render:
	 *
	 * - **xterm is loaded lazily.** It is a canvas renderer plus a parser; a
	 *   reader who never opens the pane must not download either.
	 * - **A replay resets the emulator.** `pty/load` re-sends the whole ring
	 *   buffer with `isReplay: true`; feeding that on top of what the pane
	 *   already showed would double the scrollback.
	 * - **Resize is debounced to the frame.** A drag emits one size per pixel;
	 *   only the last one is worth a notification.
	 */
	let {
		terminal,
		open = true,
		onstatus
	}: {
		terminal: TerminalBridge;
		/** Whether the pane is visible; a hidden pane keeps its shell running. */
		open?: boolean;
		/** Reports the shell's state so the tab strip can show it. */
		onstatus?: (status: 'idle' | 'connecting' | 'running' | 'exited' | 'error') => void;
	} = $props();

	let host: HTMLDivElement | null = $state(null);
	let failed = $state<string | undefined>(undefined);
	/** The PTY this component owns; one pane, one shell. */
	let terminalId = $state<string | undefined>(undefined);
	/** Set once the emulator exists, so the lazy-spawn effect can react. */
	let ready = $state(false);
	/**
	 * Frames that arrived before the shell had an id.
	 *
	 * A PTY prints its prompt immediately, and the `pty/create` round trip is
	 * slower than that. Without this buffer those first frames were dropped —
	 * a blinking cursor and no prompt — because `terminalId` was still
	 * undefined when they landed.
	 */
	let early: { id: string; event: Record<string, unknown> }[] = [];

	/** The emulator, narrowed to what this component calls. */
	interface Emulator {
		open(node: HTMLElement): void;
		write(data: string | Uint8Array): void;
		reset(): void;
		dispose(): void;
		focus(): void;
		onData(listener: (data: string) => void): { dispose(): void };
		cols: number;
		rows: number;
		loadAddon(addon: unknown): void;
	}
	interface FitAddon {
		fit(): void;
		dispose(): void;
	}

	let emulator: Emulator | undefined;
	let fit: FitAddon | undefined;
	let subscription: { dispose(): void } | undefined;
	let unsubscribe: (() => void) | undefined;
	let observer: ResizeObserver | undefined;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;

	/** The size the server last acknowledged, so an unchanged fit is a no-op. */
	let sentSize = { rows: 0, cols: 0 };

	onMount(() => {
		let cancelled = false;

		void (async () => {
			if (!host) return;
			try {
				const [{ Terminal }, { FitAddon }] = await Promise.all([
					import('@xterm/xterm'),
					import('@xterm/addon-fit'),
					// The stylesheet is part of the package; importing it here keeps
					// it out of the first paint like the rest of xterm.
					import('@xterm/xterm/css/xterm.css')
				]);
				if (cancelled || !host) return;

				const instance = new Terminal({
					cursorBlink: true,
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
					fontSize: 12,
					scrollback: 5000,
					// Transparent so the panel's own surface shows through; the
					// foreground/background pair is still set so ANSI colour 0/7
					// resolve to readable values.
					theme: {
						background: '#00000000',
						foreground: '#d4d4d8',
						cursor: '#d4d4d8'
					},
					allowProposedApi: true
				}) as unknown as Emulator;

				const fitAddon = new FitAddon();
				instance.loadAddon(fitAddon);
				instance.open(host);
				emulator = instance;
				fit = fitAddon;

				// Every keystroke goes to the shell. `onData` is already batched by
				// xterm, so a paste is one call, not one per character.
				subscription = instance.onData((data) => {
					if (terminalId) terminal.input(terminalId, encodeBase64(data));
				});

				/**
				 * Output that arrives BEFORE the create response names the PTY.
				 *
				 * A shell prints its prompt the instant it spawns, which is before
				 * the `pty/create` round trip finishes. Dropping those frames is
				 * exactly the "cursor blinks, nothing else" symptom: the prompt was
				 * written to a pane that did not yet know it owned a shell. They
				 * are buffered here and flushed as soon as the id is known.
				 */
				unsubscribe = terminal.onevent((id, event) => {
					if (terminalId === undefined) {
						early.push({ id, event });
						return;
					}
					if (id !== terminalId) return;
					handleEvent(event);
				});

				observer = new ResizeObserver(() => scheduleResize());
				observer.observe(host);
				ready = true;
				// The pane is built but does NOT spawn until it is first shown:
				// the drawer keeps both tabs mounted, so spawning here would
				// open a shell the reader never asked for whenever they open the
				// panel on the editor tab.
				if (open) await spawn();
			} catch (cause) {
				failed = cause instanceof Error ? cause.message : 'the terminal failed to load';
				onstatus?.('error');
			}
		})();
		return () => {
			cancelled = true;
			clearTimeout(resizeTimer);
			observer?.disconnect();
			unsubscribe?.();
			subscription?.dispose();
			// Closing the view closes the shell: a PTY nobody can reach would
			// keep a process alive for the life of the leader.
			if (terminalId) terminal.close(terminalId);
			emulator?.dispose();
			emulator = undefined;
		};
	});

	/** Spawn a shell, then size it to the pane. */
	async function spawn() {
		if (!emulator) return;
		onstatus?.('connecting');
		failed = undefined;
		try {
			fit?.fit();
			const id = await terminal.spawn({
				rows: emulator.rows || 24,
				cols: emulator.cols || 80
			});
			terminalId = id;
			// The shell started printing before this id existed; replay what it
			// said rather than starting the pane on an empty screen.
			const pending = early.filter((frame) => frame.id === id);
			early = [];
			for (const frame of pending) handleEvent(frame.event);
			sentSize = { rows: emulator.rows, cols: emulator.cols };
			onstatus?.('running');
			emulator.focus();
		} catch (cause) {
			early = [];
			failed = cause instanceof Error ? cause.message : 'the shell could not be started';
			onstatus?.('error');
		}
	}

	/** Fold one PTY notification into the emulator. */
	function handleEvent(event: Record<string, unknown>) {
		const type = typeof event.type === 'string' ? event.type : '';
		if (type === 'output') {
			const data = typeof event.data === 'string' ? event.data : '';
			if (!data) return;
			// A replay re-sends the WHOLE ring buffer. Feeding it on top of what
			// the pane already shows would double the scrollback, so the
			// emulator starts from a clean screen first.
			if (event.isReplay === true) emulator?.reset();
			emulator?.write(decodeBase64(data));
			return;
		}
		if (type === 'exit') {
			const code = typeof event.exitCode === 'number' ? event.exitCode : undefined;
			emulator?.write(
				`\r\n\x1b[2m[process exited${code === undefined ? '' : `: ${code}`}]\x1b[0m\r\n`
			);
			onstatus?.('exited');
		}
	}

	/**
	 * Debounce a resize to the next frame.
	 *
	 * `fit()` is cheap but the notification is not: a drag fires dozens of
	 * observer callbacks, and each one would be a message to the leader.
	 */
	function scheduleResize() {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			if (!emulator || !fit) return;
			fit.fit();
			const { rows, cols } = emulator;
			if (!terminalId || (rows === sentSize.rows && cols === sentSize.cols)) return;
			sentSize = { rows, cols };
			terminal.resize(terminalId, rows, cols);
		}, 80);
	}

	/** UTF-8 → base64, which is what the wire carries. */
	function encodeBase64(text: string): string {
		const bytes = new TextEncoder().encode(text);
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}

	/** base64 → bytes, so xterm can write multi-byte characters correctly. */
	function decodeBase64(data: string): Uint8Array {
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	}

	/**
	 * Start the shell the first time the pane is actually shown.
	 *
	 * The drawer keeps both tabs mounted, so this is what makes a hidden
	 * terminal lazy: opening the panel on the editor tab must not spawn a shell
	 * nobody asked for. `terminalId` is the guard — once a shell exists, showing
	 * the pane again only re-fits it.
	 */
	$effect(() => {
		if (!open || terminalId || !ready || !emulator) return;
		void spawn();
	});

	/** Re-run the fit when the pane is shown again. */
	$effect(() => {
		if (!open) return;
		void Promise.resolve().then(() => scheduleResize());
	});

	onDestroy(() => clearTimeout(resizeTimer));
</script>

{#if failed}
	<div class="flex h-full items-center justify-center px-6">
		<p class="text-center text-[11.5px] leading-relaxed text-ink-tertiary">{failed}</p>
	</div>
{:else}
	<div
		bind:this={host}
		class="terminal-host size-full overflow-hidden bg-code-surface"
		data-slot="xterm-host"
		role="application"
		aria-label="Interactive terminal"
	></div>
{/if}

<style>
	/* xterm sizes itself to the host; without this its canvas overflows the
	   panel and the last rows are unreachable. */
	.terminal-host :global(.xterm) {
		height: 100%;
		padding: 6px 8px;
	}
	.terminal-host :global(.xterm-viewport) {
		background-color: transparent !important;
	}
</style>
