import type { Locale } from '$lib/i18n';

/**
 * The docs UI's own vocabulary: navigation, the "not translated" banner, the
 * previous/next rail. The guide's *content* stays in English in both locales,
 * because it is the manual the binary ships and extracting it to
 * `~/.alnair/docs/user-guide` only in English — a translated copy would be a
 * second manual that goes stale the moment either side is edited.
 */
export interface DocsCopy {
	title: string;
	subtitle: string;
	languageNote: string;
	onThisPage: string;
	previous: string;
	next: string;
	allGuides: string;
	search: string;
	searchPlaceholder: string;
	searchEmpty: string;
	filter: string;
	menu: string;
	editOn: string;
	readTime: (minutes: number) => string;
	sectionCount: (count: number) => string;
}

export const docsCopy: Record<Locale, DocsCopy> = {
	en: {
		title: 'User guide',
		subtitle: 'The same manual `alnair` ships, published as a page.',
		languageNote: 'The user guide is written in English.',
		onThisPage: 'On this page',
		previous: 'Previous',
		next: 'Next',
		allGuides: 'All guides',
		search: 'Search',
		searchPlaceholder: 'Search the guide…',
		searchEmpty: 'Nothing matches that.',
		filter: 'Filter guides',
		menu: 'Contents',
		editOn: 'Edit this page',
		readTime: (minutes) => `${minutes} min read`,
		sectionCount: (count) => `${count} sections`
	},
	id: {
		title: 'Panduan pengguna',
		subtitle: 'Manual yang sama yang dikirim bersama `alnair`, diterbitkan sebagai halaman.',
		languageNote: 'Isi panduan pengguna ditulis dalam bahasa Inggris.',
		onThisPage: 'Di halaman ini',
		previous: 'Sebelumnya',
		next: 'Berikutnya',
		allGuides: 'Semua panduan',
		search: 'Cari',
		searchPlaceholder: 'Cari di panduan…',
		searchEmpty: 'Tidak ada yang cocok.',
		filter: 'Saring panduan',
		menu: 'Daftar isi',
		editOn: 'Sunting halaman ini',
		readTime: (minutes) => `${minutes} menit baca`,
		sectionCount: (count) => `${count} bagian`
	}
};
