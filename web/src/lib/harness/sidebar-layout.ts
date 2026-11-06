import type { Session, SessionStatus } from './types.js';

/**
 * How the sidebar arranges sessions.
 *
 * Two questions a reader can ask of the same list — "what is in this repo?" and
 * "what is running right now?" — and neither ordering is strictly better. So
 * the layout is a preference rather than a decision made for them, and this
 * module is the whole of it: one pure function per arrangement, no component
 * state, so the sidebar only picks and paints.
 *
 * - `workspace` is the original: one group per repo, sessions inside it. Best
 *   when the reader works in a few repos and thinks in terms of them.
 * - `status` puts Active / Idle / Inactive first and the repo inside. Best when
 *   many repos are open at once and the question is "what needs me?".
 * - `flat` drops grouping entirely: one list, most recently touched first.
 */
export type SidebarLayout = 'workspace' | 'status' | 'flat';

export const SIDEBAR_LAYOUTS: { value: SidebarLayout; label: string; hint: string }[] = [
	{ value: 'workspace', label: 'By workspace', hint: 'One group per repo' },
	{ value: 'status', label: 'By status', hint: 'Active, idle, inactive' },
	{ value: 'flat', label: 'Flat list', hint: 'Newest first, no groups' }
];

/** The three buckets the status layout paints, in the order it paints them. */
export type StatusBucket = 'active' | 'idle' | 'inactive';

export const STATUS_BUCKETS: { bucket: StatusBucket; label: string; hint: string }[] = [
	{ bucket: 'active', label: 'Active', hint: 'Running a turn or waiting on you' },
	{ bucket: 'idle', label: 'Idle', hint: 'Loaded, nothing running' },
	{ bucket: 'inactive', label: 'Inactive', hint: 'On disk, not loaded' }
];

/**
 * Which bucket a session belongs to.
 *
 * `attention` counts as active: a parked permission or question is the one
 * state the reader must not miss, and burying it under "idle" would hide the
 * only thing waiting on them. `dormant` is inactive because nothing holds it
 * resident — that is exactly the roster's meaning for the word.
 */
export function bucketOf(status: SessionStatus): StatusBucket {
	if (status === 'running' || status === 'attention') return 'active';
	if (status === 'dormant') return 'inactive';
	return 'idle';
}

/** One status bucket, with its sessions and the workspaces they came from. */
export interface StatusGroup {
	bucket: StatusBucket;
	label: string;
	hint: string;
	sessions: Session[];
}

/**
 * Arrange sessions by status, newest first inside each bucket.
 *
 * Empty buckets are dropped rather than painted as headers with nothing under
 * them: a permanent "Inactive 0" row is noise, and the reader can tell from the
 * absence that nothing is there.
 */
export function statusGroups(sessions: Session[]): StatusGroup[] {
	const byBucket = new Map<StatusBucket, Session[]>();
	for (const session of sessions) {
		const bucket = bucketOf(session.status);
		const list = byBucket.get(bucket);
		if (list) list.push(session);
		else byBucket.set(bucket, [session]);
	}

	const groups: StatusGroup[] = [];
	for (const meta of STATUS_BUCKETS) {
		const list = byBucket.get(meta.bucket);
		if (!list || list.length === 0) continue;
		groups.push({
			bucket: meta.bucket,
			label: meta.label,
			hint: meta.hint,
			sessions: [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
		});
	}
	return groups;
}

/**
 * The workspace a session's row should name, for the status layout.
 *
 * The status layout nests sessions under a status rather than a repo, so the
 * repo has to travel with the row or the reader loses the one piece of context
 * the other layout gave for free.
 */
export function workspaceLabelOf(session: Session): string {
	return session.workspace || session.cwd || 'unknown';
}

/** Every session across every group, newest first. */
export function flatSessions(sessions: Session[]): Session[] {
	return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
