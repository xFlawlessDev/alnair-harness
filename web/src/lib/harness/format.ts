/** Small formatting helpers shared by the thread and the chrome. */

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return '';
	if (ms < 1_000) return `${ms}ms`;
	const seconds = ms / 1_000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** `web/src/lib/x.ts` → `x.ts`, for the narrow rows. */
export function fileName(path: string): string {
	return baseName(path);
}

/** `web/src/lib/x.ts` → `web/src/lib/`, keeping the trailing slash. */
export function dirName(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index === -1 ? '' : path.slice(0, index + 1);
}

/** "just now", "12m", "3h", "2d" — the compact form a session list wants. */
export function formatRelative(iso: string, now: Date = new Date()): string {
	const delta = Math.max(0, now.getTime() - new Date(iso).getTime());
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return `${Math.floor(days / 7)}w`;
}

export function formatClock(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatPercent(part: number, whole: number): string {
	if (whole <= 0) return '0%';
	return `${Math.round((part / whole) * 100)}%`;
}

/** `~/dev/alnair-cli` → `alnair-cli`. */
export function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** A short, stable hue for a graph node, so the DAG art does not flicker. */
export function hashHue(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash) % 360;
}
