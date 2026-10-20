import { describe, expect, it } from 'vitest';
import { baseName, formatDuration, formatPercent, formatRelative, formatTokens } from './format.js';

describe('formatDuration', () => {
	it('renders milliseconds below a second', () => {
		expect(formatDuration(0)).toBe('0ms');
		expect(formatDuration(412)).toBe('412ms');
	});

	it('renders seconds with one decimal below ten', () => {
		expect(formatDuration(1_400)).toBe('1.4s');
		expect(formatDuration(41_200)).toBe('41s');
	});

	it('renders minutes and seconds', () => {
		expect(formatDuration(65_000)).toBe('1m 5s');
		expect(formatDuration(120_000)).toBe('2m');
	});

	it('renders nothing when the duration is unknown', () => {
		expect(formatDuration(undefined)).toBe('');
	});
});

describe('formatTokens', () => {
	it('leaves small counts alone', () => {
		expect(formatTokens(999)).toBe('999');
	});

	it('abbreviates thousands and millions', () => {
		expect(formatTokens(1_400)).toBe('1.4k');
		expect(formatTokens(61_440)).toBe('61k');
		expect(formatTokens(2_400_000)).toBe('2.4M');
	});
});

describe('formatRelative', () => {
	const now = new Date('2026-10-20T12:00:00Z');
	const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

	it('collapses anything under a minute to "now"', () => {
		expect(formatRelative(ago(0), now)).toBe('now');
		expect(formatRelative(ago(0.5), now)).toBe('now');
	});

	it('walks minutes, hours, days, weeks', () => {
		expect(formatRelative(ago(12), now)).toBe('12m');
		expect(formatRelative(ago(60 * 3), now)).toBe('3h');
		expect(formatRelative(ago(60 * 24 * 2), now)).toBe('2d');
		expect(formatRelative(ago(60 * 24 * 15), now)).toBe('2w');
	});
});

describe('formatPercent', () => {
	it('rounds to whole percent', () => {
		expect(formatPercent(1, 3)).toBe('33%');
		expect(formatPercent(2, 7)).toBe('29%');
	});

	it('guards a zero whole', () => {
		expect(formatPercent(5, 0)).toBe('0%');
	});
});

describe('baseName', () => {
	it('takes the last path segment on either separator', () => {
		expect(baseName('~/dev/alnair-cli')).toBe('alnair-cli');
		expect(baseName('C:\\dev\\alnair-cli\\')).toBe('alnair-cli');
		expect(baseName('alnair-cli')).toBe('alnair-cli');
	});
});
