/**
 * Compile the source tree into the published index. The layout is
 * maven-style: one central discovery document plus convention-based
 * per-mod files fetched on demand:
 *
 *   dist/v1/index.json                            central catalog: identity,
 *                                                 summaries, tags, releases —
 *                                                 everything searchable, no bulk
 *   dist/v1/mods/<slug>/readme.md                 rich readme (lazy-fetched)
 *   dist/v1/mods/<slug>/manifests/<version>.<artifactKey>.json
 *                                                 per-file artifact manifests
 *   dist/v1/mods/<slug>/artifacts/<version>.<artifactKey>.zip
 *                                                 mirrored artifact bytes for the
 *                                                 mod's newest mirror_versions
 *                                                 releases (same-origin download
 *                                                 for the app — GitHub release
 *                                                 URLs are not browser-fetchable)
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
import { copyFileSync } from 'node:fs'
import { loadTree, type SourceMod } from './lib/schema.ts'
import { ensureArtifactCached, lookupGithubAsset, verifyAndManifest } from './lib/artifacts.ts'
import { generateListings } from './lib/listing.ts'

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
let mirroredBytes = 0

for (const mod of mods) {
  const mirrorCount = skipArtifacts ? 0 : (mod.mirrorVersions ?? 0)
  console.log(
    `compiling ${mod.id} (${mod.releases.length} releases, mirroring newest ${mirrorCount})…`,
  )
  const releases = []
  for (const [releaseIndex, release] of sortReleases(mod).entries()) {
    const mirrorThis = releaseIndex < mirrorCount
    const artifacts = []
    for (const artifact of release.artifacts) {
      const manifestRel = `mods/${mod.slug}/manifests/${release.version}.${artifact.key}.json`
      if (!skipArtifacts) {
        const manifest = await verifyAndManifest(mod, release, artifact, cacheDir, {
          token,
          log: (m) => console.log(m),
          keepArtifact: mirrorThis,
        })
        const manifestPath = join(outDir, 'v1', manifestRel)
        mkdirSync(dirname(manifestPath), { recursive: true })
        writeFileSync(manifestPath, JSON.stringify(manifest))
      }
      let mirrorRel: string | undefined
      if (mirrorThis) {
        mirrorRel = `mods/${mod.slug}/artifacts/${release.version}.${artifact.key}.zip`
        const cachePath = await ensureArtifactCached(release, artifact, cacheDir, {
          token,
          log: (m) => console.log(m),
        })
        const mirrorPath = join(outDir, 'v1', mirrorRel)
        mkdirSync(dirname(mirrorPath), { recursive: true })
        copyFileSync(cachePath, mirrorPath)
        mirroredBytes += artifact.size
        console.log(`  mirrored → v1/${mirrorRel}`)
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
        ...(mirrorRel ? { mirror: mirrorRel } : {}),
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
  let readmePath: string | undefined
  if (mod.readme) {
    readmePath = `mods/${mod.slug}/readme.md`
    const readmeFile = join(outDir, 'v1', readmePath)
    mkdirSync(dirname(readmeFile), { recursive: true })
    writeFileSync(readmeFile, mod.readme)
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
    ...(readmePath ? { readmePath } : {}),
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

// Make the whole published tree browsable: a self-contained index.html in
// every directory (GitHub Pages serves no listings of its own).
const pages = generateListings(outDir, {
  siteTitle: 'toybox-index',
  rootBlurb:
    'The compiled <a href="https://github.com/meow-sci/toybox-index">toybox-index</a> — ' +
    'machine consumers start at <a href="v1/index.json">v1/index.json</a>; ' +
    'everything below is browsable by hand.',
})

// GitHub Pages sites have a ~1 GB soft budget; make approaching it loud.
const mirroredMb = mirroredBytes / 1024 / 1024
if (mirroredBytes > 900 * 1024 * 1024) {
  console.warn(
    `::warning::mirrored artifacts total ${mirroredMb.toFixed(0)} MB — approaching the ~1 GB GitHub Pages site budget. Reduce mirror_versions somewhere or shard the mirror.`,
  )
}

console.log(
  `\n✓ wrote ${join(outDir, 'v1', 'index.json')} (${indexMods.length} mods, ${indexMods.reduce((n, m) => n + m.releases.length, 0)} releases, ${mirroredMb.toFixed(0)} MB mirrored, ${pages} listing pages)`,
)
