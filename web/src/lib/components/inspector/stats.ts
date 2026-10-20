import { formatTokens } from '#lib/harness/format.js';
import type { ContextUsage, GraphState, Session, Turn } from '#lib/harness/types.js';

export interface InspectorStats {
	turns: number;
	parts: number;
	toolCalls: number;
	terminals: number;
	subagents: number;
	errors: number;
	reasoningMs: number;
	facts: { label: string; value: string }[];
}

/** Everything the inspector shows, derived from the transcript. */
export function inspectorStats(
	turns: Turn[],
	graph: GraphState | undefined,
	context: ContextUsage,
	session: Session
): InspectorStats {
	const parts = turns.flatMap((turn) => turn.parts);
	const reasoningMs = parts.reduce(
		(total, part) =>
			part.kind === 'reasoning' && part.durationMs ? total + part.durationMs : total,
		0
	);

	const facts = [
		{ label: 'Model', value: session.modelId ?? 'not reported' },
		{ label: 'Messages', value: String(session.numMessages) },
		{ label: 'Source', value: session.source },
		{ label: 'Window', value: `${formatTokens(context.used)} / ${formatTokens(context.limit)}` }
	];

	if (graph) {
		facts.push({
			label: 'Graph',
			value: `${graph.achieved}/${graph.total} · v${graph.planVersion}`
		});
	}

	return {
		turns: turns.length,
		parts: parts.length,
		toolCalls: parts.filter(
			(part) =>
				part.kind === 'tool' ||
				part.kind === 'file-read' ||
				part.kind === 'file-write' ||
				part.kind === 'file-edit' ||
				part.kind === 'image-read'
		).length,
		terminals: parts.filter((part) => part.kind === 'terminal').length,
		subagents: parts.filter((part) => part.kind === 'subagent').length,
		errors: parts.filter((part) => part.kind === 'error').length,
		reasoningMs,
		facts
	};
}
