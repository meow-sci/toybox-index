/**
 * Directory-listing generator: makes the published Pages tree browsable like
 * a classic autoindex / maven repository browser.
 *
 * GitHub Pages serves no directory listings, so after compilation every
 * directory under dist/ gets an index.html — completely self-contained
 * (inline CSS, no JavaScript, no external requests) — with breadcrumb
 * navigation, subdirectory traversal, and per-file view + download links.
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ListingOptions {
  siteTitle: string
  /** Shown on the root page only. */
  rootBlurb?: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1c1f24; --dim: #6b7280; --bg: #ffffff;
  --raised: #f3f4f6; --hover: #e8eaee; --border: #e5e7eb; --accent: #2563eb; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e8ec; --dim: #9aa0ac; --bg: #14161a; --raised: #1d2026;
    --hover: #262a32; --border: #32363f; --accent: #7aa2f7; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 18px; margin: 0 0 4px; }
h1 a, .crumbs a, .blurb a { color: var(--accent); text-decoration: none; }
h1 a:hover, .crumbs a:hover, .blurb a:hover { text-decoration: underline; }
.crumbs { color: var(--dim); margin-bottom: 18px; word-break: break-all; }
.blurb { color: var(--dim); margin: 0 0 18px; }
.listing { display: grid; grid-template-columns: 1fr auto auto;
  background: var(--raised); border: 1px solid var(--border);
  border-radius: 10px; overflow: hidden; }
.hd { font-weight: 600; color: var(--dim); font-size: 12px; padding: 8px 14px; }
.cell { border-top: 1px solid var(--border); display: flex; align-items: center; }
.name { padding: 7px 14px; color: var(--accent); text-decoration: none;
  word-break: break-all; }
a.name:hover { background: var(--hover); }
.size { padding: 7px 14px; justify-content: flex-end; white-space: nowrap;
  color: var(--dim); font-variant-numeric: tabular-nums; }
.dl { padding: 7px 14px; justify-content: flex-end; }
.dl a { font-size: 12px; border: 1px solid var(--border); border-radius: 6px;
  padding: 1px 8px; color: var(--dim); text-decoration: none; white-space: nowrap; }
.dl a:hover { color: var(--accent); border-color: var(--accent); }
.up { font-family: ui-monospace, monospace; }
.dir::before { content: '📁 '; }
.file::before { content: '📄 '; }
.empty { padding: 7px 14px; color: var(--dim); grid-column: 1 / -1;
  border-top: 1px solid var(--border); }
footer { color: var(--dim); font-size: 12px; margin-top: 16px; }
`.trim()

function renderListing(
  relPath: string[],
  dirs: string[],
  files: { name: string; size: number }[],
  opts: ListingOptions,
): string {
  const here = relPath.length === 0 ? '/' : `/${relPath.join('/')}/`
  const crumbs = [
    `<a href="${'../'.repeat(relPath.length) || './'}">${escapeHtml(opts.siteTitle)}</a>`,
    ...relPath.map((seg, i) => {
      const up = relPath.length - 1 - i
      return `<a href="${'../'.repeat(up) || './'}">${escapeHtml(seg)}</a>`
    }),
  ].join(' / ')

  // Each row is three grid cells; the whole name cell IS the link.
  const row = (nameCell: string, size: string, dl: string): string =>
    `${nameCell}<span class="cell size">${size}</span><span class="cell dl">${dl}</span>`
  const rows: string[] = []
  if (relPath.length > 0) {
    rows.push(row(`<a class="cell name up" href="../">../</a>`, '—', ''))
  }
  for (const d of dirs) {
    const href = `${encodeURIComponent(d)}/`
    rows.push(row(`<a class="cell name dir" href="${href}">${escapeHtml(d)}/</a>`, '—', ''))
  }
  for (const f of files) {
    const href = encodeURIComponent(f.name)
    rows.push(
      row(
        `<a class="cell name file" href="${href}">${escapeHtml(f.name)}</a>`,
        formatSize(f.size),
        `<a href="${href}" download>download</a>`,
      ),
    )
  }
  if (rows.length === 0) rows.push('<span class="empty">(empty)</span>')

  const blurb =
    relPath.length === 0 && opts.rootBlurb ? `<p class="blurb">${opts.rootBlurb}</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.siteTitle)}${escapeHtml(here)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Index of ${escapeHtml(here)}</h1>
<p class="crumbs">${crumbs}</p>
${blurb}
<div class="listing">
<span class="hd">Name</span><span class="hd size">Size</span><span class="hd dl"></span>
${rows.join('\n')}
</div>
<footer>toybox index browser</footer>
</main>
</body>
</html>
`
}

/** Write an index.html into every directory under rootDir. Returns the count. */
export function generateListings(rootDir: string, opts: ListingOptions): number {
  let count = 0
  const walk = (dir: string, relPath: string[]): void => {
    const dirs: string[] = []
    const files: { name: string; size: number }[] = []
    for (const name of readdirSync(dir).sort()) {
      if (name === 'index.html') continue
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) dirs.push(name)
      else files.push({ name, size: stat.size })
    }
    writeFileSync(join(dir, 'index.html'), renderListing(relPath, dirs, files, opts))
    count++
    for (const d of dirs) walk(join(dir, d), [...relPath, d])
  }
  walk(rootDir, [])
  return count
}
