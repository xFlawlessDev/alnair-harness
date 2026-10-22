/**
 * Replay/live dedup for `session/load` streams.
 *
 * The leader already performs this bookkeeping *within a single load*
 * (`load_replay_max_seq` in `leader/server.rs`): it buffers live frames that
 * arrive while the replay is in flight, then drops the buffered copies whose
 * `event_seq` the replay already delivered. It deliberately does **not** dedup
 * across loads — that is the client's job, because only the client knows what
 * it has already folded into its view model.
 *
 * Without this, every reconnect (or every leader relaunch) replays the whole
 * transcript into an accumulator that already holds it and the conversation
 * doubles.
 *
 * `eventId` is `<session_id>-<seq>` and `seq` is monotonic per session. The
 * server parses it the same way (`event_seq_of`: split on the last `-`), so a
 * session id containing dashes is handled.
 *
 * Frames without an `eventId` always apply: some notifications are
 * fire-and-forget and carry no sequence at all (`interaction_resolved`,
 * `retry_state`, `model_changed`, …). Dropping those on a sequence comparison
 * would silently lose state.
 */

/** Which half of a `session/load` this session is in. */
export type GatePhase = 'live' | 'replay';

export interface GateState {
	readonly phase: GatePhase;
	/** Highest `eventId` sequence folded into the accumulator so far. */
	readonly lastSeq: number;
}

export const liveGate = (): GateState => ({ phase: 'live', lastSeq: 0 });

/**
 * Reset before sending `session/load`.
 *
 * Every frame from here until `endReplay` is applied unconditionally — the
 * transcript is being rebuilt from scratch — and the highest sequence is
 * remembered as the new watermark.
 */
export const beginReplay = (): GateState => ({ phase: 'replay', lastSeq: 0 });

/** The `session/load` response landed; switch to watermark comparison. */
export const endReplay = (state: GateState): GateState =>
	state.phase === 'replay' ? { ...state, phase: 'live' } : state;

/**
 * Parse the sequence out of an `eventId`.
 *
 * Returns `undefined` for an absent or unparseable id, which callers must treat
 * as "always apply" rather than "sequence zero".
 */
export function parseEventSeq(eventId: unknown): number | undefined {
	if (typeof eventId !== 'string') return undefined;
	const cut = eventId.lastIndexOf('-');
	if (cut < 0 || cut === eventId.length - 1) return undefined;
	const seq = Number(eventId.slice(cut + 1));
	return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

/**
 * Read `_meta.eventId` out of a notification's params.
 *
 * Two wire forms exist, both produced by the gateway: direct
 * (`params._meta.eventId`) and wrapped, where the real params sit one level
 * down under `params.params` (see the leader's `event_seq_of`). Both are
 * checked so a wrapped ext notification is not mistaken for an unsequenced one.
 */
export function eventIdOf(params: unknown): unknown {
	if (!params || typeof params !== 'object') return undefined;
	const direct = (params as { _meta?: { eventId?: unknown } })._meta;
	if (direct && typeof direct === 'object' && 'eventId' in direct) return direct.eventId;
	const inner = (params as { params?: unknown }).params;
	if (inner && typeof inner === 'object') {
		const nested = (inner as { _meta?: { eventId?: unknown } })._meta;
		if (nested && typeof nested === 'object' && 'eventId' in nested) return nested.eventId;
	}
	return undefined;
}

/**
 * Decide whether a frame belongs in the accumulator.
 *
 * During replay everything applies and the watermark advances. Afterwards a
 * frame at or below the watermark has already been folded and is dropped.
 * Unsequenced frames always apply.
 */
export function admit(state: GateState, eventId: unknown): { apply: boolean; state: GateState } {
	const seq = parseEventSeq(eventId);

	if (state.phase === 'replay') {
		if (seq === undefined) return { apply: true, state };
		return {
			apply: true,
			state: seq > state.lastSeq ? { ...state, lastSeq: seq } : state
		};
	}

	if (seq === undefined) return { apply: true, state };
	if (seq <= state.lastSeq) return { apply: false, state };
	return { apply: true, state: { ...state, lastSeq: seq } };
}
