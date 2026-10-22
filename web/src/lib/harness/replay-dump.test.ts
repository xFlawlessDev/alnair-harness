import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emptyAcc, reduceAcpUpdate, reduceExtUpdate } from './reducer.js';
import type { Acc } from './reducer.js';
import type { SessionUpdate } from './types/acp.js';
import type { ExtSessionUpdate } from './types/ext.js';

/**
 * Fold a real replay dump through the reducer.
 *
 * `target/replay-frames.json` is written by `scripts/web-session-probe.mjs`
 * from a live leader. This test exists because an empty transcript has two
 * possible causes — the wire sent nothing, or the reducer dropped what it
 * sent — and only folding the captured frames tells them apart.
 *
 * It is skipped when the dump is absent, so a clean checkout (no probe run)
 * still passes.
 */
function loadDump(): { method: string; raw: Record<string, unknown> }[] | undefined {
	// `npm test` runs from `web/`, so the workspace `target/` is one level up.
	for (const candidate of [
		resolve(process.cwd(), '../target/replay-frames.json'),
		resolve(process.cwd(), 'target/replay-frames.json')
	]) {
		try {
			return JSON.parse(readFileSync(candidate, 'utf8'));
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}

describe('replay: a captured live dump folds into a transcript', () => {
	const frames = loadDump();

	it.skipIf(!frames)('produces turns from the frames the leader sent', () => {
		let acc: Acc = emptyAcc();
		let now = Date.parse('2026-10-22T09:00:00Z');
		for (const frame of frames ?? []) {
			now += 10;
			const update = frame.raw.update as Record<string, unknown> | undefined;
			if (!update) continue;
			const ctx = { now, sessionId: 's' };
			acc =
				frame.method === '_alnair/session/update'
					? reduceExtUpdate(acc, update as ExtSessionUpdate, ctx)
					: reduceAcpUpdate(acc, update as SessionUpdate, ctx);
		}

		expect(acc.turns.length).toBeGreaterThan(0);
		const kinds = acc.turns.flatMap((turn) => turn.parts.map((part) => part.kind));
		expect(kinds).toContain('terminal');
	});
});

describe('replay: ambient updates never leave a turn open', () => {
	it('a recap after the last turn_completed does not start a streaming turn', () => {
		// The captured dump ends with `turn_completed` → `session_recap`. The
		// recap used to open a turn marked `streaming`, and nothing would ever
		// close it: the UI showed a spinner and a stop button for an idle
		// session. Regression test for that.
		let acc: Acc = emptyAcc();
		let now = Date.parse('2026-10-22T09:00:00Z');
		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'user_message_chunk',
				content: { type: 'text', text: 'hi' }
			} as unknown as SessionUpdate,
			{ now, sessionId: 's' }
		);
		now += 10;
		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'hello' }
			} as unknown as SessionUpdate,
			{ now, sessionId: 's' }
		);
		now += 10;
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'turn_completed',
				prompt_id: 'p1',
				stop_reason: 'end_turn'
			} as unknown as ExtSessionUpdate,
			{ now, sessionId: 's' }
		);
		expect(acc.openTurnId).toBeUndefined();

		now += 10;
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'session_recap',
				summary: 'you asked a question',
				auto: false
			} as unknown as ExtSessionUpdate,
			{ now, sessionId: 's' }
		);

		expect(acc.openTurnId).toBeUndefined();
		expect(acc.turns.every((turn) => turn.status !== 'streaming')).toBe(true);
		// The recap joins the assistant turn it recaps rather than the user
		// prompt above it.
		const assistant = acc.turns.find((turn) => turn.role === 'assistant');
		expect(assistant?.parts.some((part) => part.kind === 'notice')).toBe(true);
	});

	it('a notice with no prior turn becomes a closed system turn', () => {
		const acc = reduceExtUpdate(
			emptyAcc(),
			{
				sessionUpdate: 'session_recap',
				summary: 'nothing yet',
				auto: true
			} as unknown as ExtSessionUpdate,
			{ now: Date.parse('2026-10-22T09:00:00Z'), sessionId: 's' }
		);
		expect(acc.openTurnId).toBeUndefined();
		expect(acc.turns).toHaveLength(1);
		expect(acc.turns[0].role).toBe('system');
		expect(acc.turns[0].status).toBe('complete');
	});
});
