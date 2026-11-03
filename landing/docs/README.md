# The docs pipeline

One copy of the user guide lives at `crates/codegen/alnair-tui/docs/user-guide/`.
The TUI embeds those bytes with `include_str!` and extracts them to
`~/.alnair/docs/user-guide`; the site reads the same bytes at build time.
A guide that exists in two places will drift; this one cannot.

```
crate docs          ──▶  TUI docs picker + ~/.alnair/docs/user-guide
     │ (build time)
     ▼
 /docs/             /id/docs/   prerendered HTML per chapter
```

## Sources

| Module                             | Role                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/docs/source.ts`           | Titles, slugs, order and file paths — parsed from the TUI's own registry (`docs.rs`, `USER_GUIDE`), never retyped. A `guide!` entry without a file is a build error.                    |
| `src/lib/docs/render.ts`           | Markdown → HTML. Sibling-doc links (`10-hooks.md`) become site links; headings get ids; transcripts stay unhighlighted; cross-document anchors are repaired against the ids that exist. |
| `src/lib/docs/highlight.server.ts` | Build-time Shiki only. The browsers never load it — tokens are baked into the HTML. Languages: the ones the guide fences.                                                               |
| `src/lib/docs/prose.css`           | The article's styles: tables that scroll in place, stashed-column code, inline code, callout blockquotes.                                                                               |

## Conventions

- Content stays English in both locales. The site publishes the manual the
  binary ships; a translated copy would be a second manual that goes stale.
  `src/lib/docs/copy.ts` carries only the page chrome (nav, "On this page",
  prev/next), which genuinely needs translating.
- A link that would leave the guide is not a link. `../../plan/…` (a design
  doc the binary does not ship) renders as its text, and a `#fragment` that
  matches no heading is pushed — first an exact match, then a loose one —
  or dropped rather than pointed at nothing.
- The leading `#` title is stripped: the page already prints the registry's
  title and description as its header.
- `npm run build && node scripts/check-links.mjs` checks every anchor on every
  page. The prerenderer fails on cross-page fragments; the script additionally
  covers the Indonesian mirror and the hand-written anchors.
