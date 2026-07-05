/**
 * PR validation gate.
 *
 *   node scripts/validate.ts [--artifacts] [--pr-author <login>] [--base-ref <ref>]
 *                            [--changed <file-with-list>]
 *
 * Always: parse + validate the whole mods/ tree (schema, slugs, versions,
 * cross-references, unexpected files).
 *
 * --artifacts: download + verify every changed release's artifacts and
 * generate their file manifests (cached by content hash).
 *
 * --pr-author + --base-ref + --changed: governance checks for the auto-merge
 * pipeline. Prints machine-readable outcomes:
 *   ::set-result ownership=ok|not-owner|new-mod|out-of-scope
 * Ownership is read from the BASE ref's mod.toml (a PR cannot grant itself
 * ownership). "new-mod" (folder absent on base) and any change outside
 * mods/<slug>/** require human review.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { loadTree, parseModToml, ValidationError } from './lib/schema.ts'
import { verifyAndManifest } from './lib/artifacts.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const rootDir = process.cwd()
const checkArtifacts = flag('--artifacts')
const prAuthor = opt('--pr-author')
const baseRef = opt('--base-ref') ?? 'origin/main'
const changedListFile = opt('--changed')

function fail(message: string): never {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

function output(key: string, value: string): void {
  console.log(`::result ${key}=${value}`)
  const ghOut = process.env.GITHUB_OUTPUT
  if (ghOut) appendFileSync(ghOut, `${key}=${value}\n`)
}

// ---------------------------------------------------------------------------
// 1. Schema validation of the whole tree
// ---------------------------------------------------------------------------

let mods
try {
  mods = loadTree(rootDir)
} catch (e) {
  if (e instanceof ValidationError) fail(e.message)
  throw e
}
console.log(`✓ schema: ${mods.length} mods, ${mods.reduce((n, m) => n + m.releases.length, 0)} releases`)

// ---------------------------------------------------------------------------
// 2. Governance (auto-merge eligibility) when PR context is provided
// ---------------------------------------------------------------------------

const changed: string[] = changedListFile
  ? readFileSync(changedListFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : []

if (prAuthor && changed.length > 0) {
  let verdict: 'ok' | 'not-owner' | 'new-mod' | 'out-of-scope' = 'ok'
  const touchedSlugs = new Set<string>()
  for (const file of changed) {
    const m = /^mods\/([^/]+)\//.exec(file)
    if (!m) {
      console.log(`  governance: "${file}" is outside mods/ — human review required`)
      verdict = 'out-of-scope'
      break
    }
    touchedSlugs.add(m[1]!)
  }
  if (verdict === 'ok') {
    for (const slug of touchedSlugs) {
      // Owners come from the BASE ref. A missing base mod.toml = new mod.
      let baseToml: string
      try {
        baseToml = execFileSync('git', ['show', `${baseRef}:mods/${slug}/mod.toml`], {
          encoding: 'utf8',
        })
      } catch {
        console.log(`  governance: mods/${slug} is new — human review required`)
        verdict = 'new-mod'
        break
      }
      const baseIdentity = parseModToml(`(base) mods/${slug}/mod.toml`, baseToml)
      const owners = baseIdentity.owners.map((o) => o.toLowerCase())
      if (!owners.includes(prAuthor.toLowerCase())) {
        console.log(
          `  governance: @${prAuthor} is not an owner of mods/${slug} (owners: ${baseIdentity.owners.join(', ')})`,
        )
        verdict = 'not-owner'
        break
      }
      // Changing the owners list itself always needs human review.
      const headMod = mods.find((m) => m.slug === slug)
      if (
        headMod &&
        JSON.stringify([...headMod.owners].sort()) !== JSON.stringify([...baseIdentity.owners].sort())
      ) {
        console.log(`  governance: mods/${slug} owners changed — human review required`)
        verdict = 'new-mod'
        break
      }
    }
  }
  output('ownership', verdict)
  console.log(`✓ governance verdict: ${verdict}`)
}

// ---------------------------------------------------------------------------
// 3. Artifact verification (changed releases only, unless none specified)
// ---------------------------------------------------------------------------

if (checkArtifacts) {
  const cacheDir = `${rootDir}/cache`
  const token = process.env.GITHUB_TOKEN
  const changedReleaseFiles = new Set(
    changed.filter((f) => /^mods\/[^/]+\/releases\/[^/]+\.toml$/.test(f)),
  )
  const scope =
    changedReleaseFiles.size > 0
      ? (file: string) => changedReleaseFiles.has(file)
      : () => true
  let checked = 0
  for (const mod of mods) {
    for (const release of mod.releases) {
      if (!scope(release.file)) continue
      console.log(`verifying ${mod.id}@${release.version}…`)
      for (const artifact of release.artifacts) {
        await verifyAndManifest(mod, release, artifact, cacheDir, {
          token,
          log: (msg) => console.log(msg),
        })
        checked++
      }
    }
  }
  console.log(`✓ artifacts: ${checked} verified`)
}

console.log('\nAll checks passed.')
