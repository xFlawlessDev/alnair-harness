/**
 * `<system-reminder>` payloads, and why they are not user prompts.
 *
 * The shell injects context as a synthetic USER message — see
 * `ConversationItem::system_reminder` in `alnair-shell/src/session/conversation.rs`:
 * `push_system_reminder` wraps the body in `<system-reminder>…</system-reminder>`
 * and pushes it through `push_user_message`, so the model reads it as context
 * in the conversation rather than as a system turn. On the wire that becomes an
 * ordinary `user_message_chunk`, which is exactly why a browser that renders
 * every user chunk as a bubble shows a background-task notification as if the
 * reader had typed it.
 *
 * The wrapper is the whole signal. Producers go through a small set of tags
 * (`alnair-tools/src/reminders` plus the harness modules):
 *
 * | Tag | Written by |
 * |---|---|
 * | `system-reminder` | background-task completions, skill/date notices, hooks |
 * | `memory-context` | the memory subsystem's injected context |
 * | `harness-lessons` | the lesson library |
 * | `agent_skills` | the compat preamble's skill baseline |
 * | `goal-state` | the goal harness |
 *
 * A message is treated as a system note only when it STARTS with a wrapper and
 * ENDS with that wrapper's closer. Anchoring both ends matters: an ordinary
 * prompt may quote a tag (`"why does <system-reminder> show up?"`), and
 * swallowing that as chrome would hide a real question.
 */
export interface SystemEnvelope {
	/** The wrapper name, without angle brackets. */
	tag: string;
	/** The body with the wrapper removed, trimmed. */
	body: string;
}

/**
 * `<tag>\n…\n</tag>` — the shape `push_system_reminder_with_tag` writes.
 *
 * Deliberately not limited to the tags above: an unknown wrapper enclosing the
 * WHOLE message is almost certainly an injection this build has not learned
 * about yet, and rendering it as a user bubble is the visible failure this
 * module exists to prevent. Only a message that is wholly one wrapper counts,
 * so a prompt that merely contains markup stays a prompt.
 */
const ENVELOPE = /^\s*<([a-z][a-z0-9_-]*)>\s*\n?([\s\S]*?)\n?\s*<\/\1>\s*$/i;

/** Read a message as an injected system envelope, if that is what it is. */
export function systemEnvelope(text: string): SystemEnvelope | undefined {
	const match = ENVELOPE.exec(text);
	if (!match) return undefined;
	const body = match[2].trim();
	// An empty wrapper is not worth a row, and treating it as a note would
	// silently drop the message instead of showing the (empty) bubble.
	if (body.length === 0) return undefined;
	return { tag: match[1].toLowerCase(), body };
}

/** Whether a whole message is an injected envelope. */
export function isSystemEnvelope(text: string): boolean {
	return systemEnvelope(text) !== undefined;
}

/**
 * A human label for a wrapper tag.
 *
 * The tag names a mechanism; a reader needs a noun. Anything unlisted falls
 * back to the tag itself with its separators turned into spaces, which is
 * honest — better "skill information" than a confident wrong label.
 */
export function systemNoteLabel(tag: string): string {
	switch (tag) {
		case 'system-reminder':
			return 'System reminder';
		case 'memory-context':
			return 'Memory';
		case 'harness-lessons':
			return 'Harness lessons';
		case 'agent_skills':
			return 'Agent skills';
		case 'goal-state':
			return 'Goal state';
		case 'skill_information':
			return 'Skill';
		case 'user_query':
			return 'Query';
		default:
			return tag.replace(/[_-]+/g, ' ');
	}
}
