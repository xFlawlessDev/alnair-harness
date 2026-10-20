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
	graph: GraphState,
	context: ContextUsage,
	session: Session
): InspectorStats {
	const parts = turns.flatMap((turn) => turn.parts);
	const reasoningMs = parts.reduce(
		(total, part) =>
			part.kind === 'reasoning' && part.durationMs ? total + part.durationMs : total,
		0
	);

	return {
		turns: turns.length,
		parts: parts.length,
		toolCalls: parts.filter((part) => part.kind === 'tool').length,
		terminals: parts.filter((part) => part.kind === 'terminal').length,
		subagents: parts.filter((part) => part.kind === 'subagent').length,
		errors: parts.filter((part) => part.kind === 'error').length,
		reasoningMs,
		facts: [
			{ label: 'Model', value: session.model },
			{ label: 'Tokens billed', value: formatTokens(session.tokens) },
			{ label: 'Window', value: `${formatTokens(context.used)} / ${formatTokens(context.limit)}` },
			{ label: 'Graph nodes', value: `${graph.nodes.length}` }
		]
	};
}
