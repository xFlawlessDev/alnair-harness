# The Alnair landing site

Marketing site for Alnair: a fully prerendered static build — no Worker script,
no server, nothing to keep warm.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # writes build/
npm run preview  # serve the built site
npm run check    # svelte-check: types and Svelte diagnostics
npm run lint     # prettier + eslint
```

## What is here

| Path                                      | Contents                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/routes/+page.svelte`                 | English landing page (`/`).                                                                             |
| `src/routes/id/`                          | Indonesian mirror (`/id/`), same sections.                                                              |
| `src/routes/docs/`, `src/routes/id/docs/` | The user guide, prerendered from the app's own markdown.                                                |
| `src/lib/content/`                        | `en.ts` / `id.ts`, both `satisfies SiteCopy` — adding a section without translating it is a type error. |
| `src/lib/components/`                     | Landing sections. `mock/` holds the UI samples the feature cards show — markup, not screenshots.        |
| `src/lib/docs/`                           | The docs pipeline. `landing/docs/README.md` is its source of truth.                                     |
| `scripts/`                                | `shot.mjs` / `measure.mjs` (headless browser checks over CDP), `check-links.mjs`, `build-demo.ps1`.     |

## Cloudflare

Either target works; they differ only in which command you run.

### Workers static assets (recommended)

`wrangler.jsonc` already describes the deployment, so there is not even an
install step in the build:

| Setting        | Value                 |
| -------------- | --------------------- |
| Build command  | `npm run build`       |
| Deploy command | `npx wrangler deploy` |
| Root directory | `landing`             |

```sh
npm run build
npx wrangler deploy
```

### Pages

```sh
npm run build
npx wrangler pages deploy build
```

Or, in the Pages dashboard: framework preset **None**, build command
`npm run build`, output directory `build`, root directory `landing`.

## Why a separate project

`web/` is the app: a SPA that `rust-embed`s into the `alnair` binary and is
served by `alnair web`. Marketing copy must not ship inside the agent, so this
site never touches the Cargo workspace or the `web/` gates. It is a separate
npm project with its own `check` and `lint`.

It does share the app's identity rather than re-inventing one: the same design
tokens (`web/src/routes/layout.css`), the same self-hosted Geist fonts, and the
same mark.

## Assets

| File                                    | Source                  | Note                                                                           |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `static/media/alnair-demo.{mp4,webm}`   | `video/alnair.gif`      | 15 MB GIF → ~580 KB MP4. Re-run `scripts/build-demo.ps1` after re-recording.   |
| `static/media/alnair-demo-poster.jpg`   | a frame of the same GIF | `preload="none"` means the poster is what a reader sees until they press play. |
| `static/fonts/*.woff2`                  | `web/static/fonts/`     | Copied, not symlinked: the two projects build independently.                   |
| `static/favicon.svg`, `static/logo.svg` | `web/src/lib/assets/`   | The same art, so the tab icon matches the app.                                 |

Nothing loads from a CDN — the whole page is one folder.

## Checks worth running after a change

```sh
npm run check && npm run lint && npm run build
node scripts/check-links.mjs        # every internal link and #anchor
node scripts/measure.mjs <url> 1600 # which blocks overflow their column
node scripts/shot.mjs <url> dark out.png 1600 0
```

`measure.mjs` reports the code blocks and tables that still scroll sideways,
with their first line — enough to tell a genuinely wide snippet from a layout
bug. The guide's longest TOML examples (100+ columns) do scroll in place, which
is intended: they are wider than any sane reading measure.
