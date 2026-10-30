import { describe, expect, it } from 'vitest';
import { isWebCommand, normalizeCommandName, webCommands } from './commands.js';
import type { SlashCommand } from './types.js';

const command = (name: string): SlashCommand => ({ name, description: `${name} command` });

describe('normalizeCommandName', () => {
	it('strips the leading slash and lowercases', () => {
		expect(normalizeCommandName('/Compact')).toBe('compact');
		expect(normalizeCommandName('compact')).toBe('compact');
	});

	it('resolves the aliases the pager knows', () => {
		expect(normalizeCommandName('yolo')).toBe('always-approve');
		expect(normalizeCommandName('mem')).toBe('memory');
		expect(normalizeCommandName('info')).toBe('session-info');
		expect(normalizeCommandName('status')).toBe('session-info');
		expect(normalizeCommandName('plugin')).toBe('plugins');
	});
});

describe('isWebCommand', () => {
	it('keeps the server-side builtins the agent advertises', () => {
		for (const name of [
			'compact',
			'always-approve',
			'flush',
			'dream',
			'memory',
			'context',
			'session-info',
			'lessons',
			'goal',
			'graph',
			'swarm',
			'loop',
			'feedback',
			'hooks-list',
			'plugins'
		]) {
			expect(isWebCommand(name), name).toBe(true);
		}
	});

	it('drops the commands that only exist in the pager', () => {
		for (const name of [
			'model',
			'clear',
			'rewind',
			'theme',
			'vim-mode',
			'terminal-setup',
			'help',
			'quit',
			'resume',
			'fork',
			'new',
			'rename',
			'export',
			'mcps',
			'dashboard'
		]) {
			expect(isWebCommand(name), name).toBe(false);
		}
	});

	it('judges an alias by the name it resolves to', () => {
		// `/yolo` IS `/always-approve`, which the shell runs server-side.
		expect(isWebCommand('yolo')).toBe(true);
		expect(isWebCommand('/YOLO')).toBe(true);
		// `/info` is the session-info alias, also server-side.
		expect(isWebCommand('info')).toBe(true);
	});

	it('allows an unknown name, so a skill and a future builtin both survive', () => {
		// A denylist, not an allowlist: a skill the user installed must appear
		// without anyone editing this module.
		expect(isWebCommand('commit')).toBe(true);
		expect(isWebCommand('deploy')).toBe(true);
		expect(isWebCommand('some-future-builtin')).toBe(true);
	});

	it('rejects an empty name', () => {
		expect(isWebCommand('')).toBe(false);
		expect(isWebCommand('/')).toBe(false);
		expect(isWebCommand('   ')).toBe(false);
	});
});

describe('webCommands', () => {
	it('filters in the agent’s own order', () => {
		const filtered = webCommands([
			command('compact'),
			command('model'),
			command('goal'),
			command('theme'),
			command('commit')
		]);
		expect(filtered.map((entry) => entry.name)).toEqual(['compact', 'goal', 'commit']);
	});

	it('keeps an empty list empty', () => {
		expect(webCommands([])).toEqual([]);
	});
});
