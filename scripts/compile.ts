/**
 * Compile the source tree into the published index:
 *
 *   dist/v1/index.json                                (the catalog, readmes inlined)
 *   dist/v1/manifests/<slug>/<version>.<key>.json     (per-file manifests)
 *
 * Artifacts are verified + manifested via the content-addressed cache
 * (cache/manifests/<sha256>.json), so unchanged artifacts are never
 * re-downloaded. GitHub API asset URLs (the CORS-viable download path for
 * browsers) are resolved here and embedded as `apiUrl`.
 *
 *   node scripts/compile.ts [--out dist] [--skip-artifacts]
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { loadTree, type SourceMod } from './lib/schema.ts'
import { lookupGithubAsset, verifyAndManifest } from './lib/artifacts.ts'

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const skipArtifacts = args.includes('--skip-artifacts')

const rootDir = process.cwd()
const outDir = join(rootDir, opt('--out') ?? 'dist')
const cacheDir = join(rootDir, 'cache')
const token = process.env.GITHUB_TOKEN

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Newest-first by semver (channel-agnostic; the app filters channels). */
function sortReleases(mod: SourceMod): SourceMod['releases'] {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2)
    const [maj = 0, min = 0, pat = 0] = core!.split('.').map(Number)
    return { maj, min, pat, pre: pre ?? '' }
  }
  return [...mod.releases].sort((a, b) => {
    const A = parse(a.version)
    const B = parse(b.version)
    if (A.maj !== B.maj) return B.maj - A.maj
    if (A.min !== B.min) return B.min - A.min
    if (A.pat !== B.pat) return B.pat - A.pat
    if (A.pre === B.pre) return 0
    if (A.pre === '') return -1
    if (B.pre === '') return 1
    return A.pre < B.pre ? 1 : -1
  })
}

const mods = loadTree(rootDir)
const indexMods = []

for (const mod of mods) {
  console.log(`compiling ${mod.id} (${mod.releases.length} releases)…`)
  const releases = []
  for (const release of sortReleases(mod)) {
    const artifacts = []
    for (const artifact of release.artifacts) {
      const manifestRel = `manifests/${mod.slug}/${release.version}.${artifact.key}.json`
      if (!skipArtifacts) {
        const manifest = await verifyAndManifest(mod, release, artifact, cacheDir, {
          token,
          log: (m) => console.log(m),
        })
        const manifestPath = join(outDir, 'v1', manifestRel)
        mkdirSync(dirname(manifestPath), { recursive: true })
        writeFileSync(manifestPath, JSON.stringify(manifest))
      }
      const gh = await lookupGithubAsset(artifact.url, token)
      artifacts.push({
        key: artifact.key,
        platforms: artifact.platforms,
        url: artifact.url,
        ...(gh ? { apiUrl: gh.apiUrl } : {}),
        size: artifact.size,
        sha256: artifact.sha256,
        root: artifact.root,
        installAs: artifact.installAs,
        ...(skipArtifacts ? {} : { manifest: manifestRel }),
      })
    }
    releases.push({
      version: release.version,
      channel: release.channel,
      ...(release.published ? { publishedAt: release.published } : {}),
      ...(release.ksa ? { ksa: release.ksa } : {}),
      ...(release.notes ? { notes: release.notes } : {}),
      dependencies: release.dependencies,
      conflicts: release.conflicts,
      artifacts,
    })
  }
  indexMods.push({
    id: mod.id,
    name: mod.name,
    summary: mod.summary,
    authors: mod.authors,
    ...(mod.license ? { license: mod.license } : {}),
    ...(mod.repository ? { repository: mod.repository } : {}),
    ...(mod.homepage ? { homepage: mod.homepage } : {}),
    tags: mod.tags,
    owners: mod.owners,
    ...(mod.readme ? { readme: mod.readme } : {}),
    releases,
  })
}

const index = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: { repository: 'meow-sci/toybox-index', commit: gitCommit() },
  mods: indexMods,
}

mkdirSync(join(outDir, 'v1'), { recursive: true })
writeFileSync(join(outDir, 'v1', 'index.json'), JSON.stringify(index))
// A tiny landing page so the Pages root isn't a 404.
writeFileSync(
  join(outDir, 'index.html'),
  '<!doctype html><title>toybox-index</title><p>Compiled KSA mod index. See <a href="v1/index.json">v1/index.json</a>.</p>',
)
console.log(
  `\n✓ wrote ${join(outDir, 'v1', 'index.json')} (${indexMods.length} mods, ${indexMods.reduce((n, m) => n + m.releases.length, 0)} releases)`,
)
