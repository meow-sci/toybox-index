/**
 * Source-metadata schema: parse + validate the human-authored TOML under
 * mods/<slug>/ into the shapes the compiled index is built from.
 *
 * Run under Node >= 24 (native TypeScript type stripping) — plain JS with
 * type annotations only.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export type Platform = 'windows' | 'linux' | 'macos'
export const ALL_PLATFORMS: Platform[] = ['windows', 'linux', 'macos']

/**
 * Artifact size policy (CI + user self-protection).
 *
 * Every artifact defaults to a 50 MiB ceiling. A mod that genuinely ships
 * bigger payloads must declare `max_artifact_bytes` in its mod.toml — a
 * registration-level decision: changing it is treated like an owners change
 * (admin review, never auto-merged), so a release PR cannot silently raise
 * its own ceiling. HARD_MAX_ARTIFACT_BYTES is an absolute cap no metadata
 * can override; the artifact verifier additionally aborts any download the
 * moment it exceeds the declared size, so CI never streams unbounded data
 * regardless of what a PR claims.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
export const HARD_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024

export function effectiveMaxArtifactBytes(mod: Pick<SourceMod, 'maxArtifactBytes'>): number {
  return Math.min(mod.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES, HARD_MAX_ARTIFACT_BYTES)
}

export interface SourceMod {
  slug: string
  id: string
  name: string
  summary: string
  authors: string[]
  license?: string
  repository?: string
  homepage?: string
  tags: string[]
  owners: string[]
  /**
   * REQUIRED social permission filter: regex patterns (matched full,
   * case-insensitive, against referrer mod IDS — never versions) governing
   * which mods may declare required/recommends references to this one.
   * Exclusions always win. The expected default is include = [".*"].
   */
  whoCanReference: { include: string[]; exclude: string[] }
  /** Per-registration artifact size ceiling override (bytes). */
  maxArtifactBytes?: number
  /**
   * How many of the mod's newest releases have their artifacts mirrored
   * into the published Pages site (same-origin for the app — the only
   * zero-infrastructure host that is browser-fetchable; GitHub release
   * downloads do not speak CORS). 0/unset = no mirroring; registration-level
   * setting, changed only under admin review (Pages budget is finite).
   */
  mirrorVersions?: number
  readme?: string
  releases: SourceRelease[]
}

/** One cross-mod reference: who, which versions, and why. */
export interface SourceReference {
  id: string
  range: string
  description?: string
}

export interface SourceRelease {
  file: string
  version: string
  channel: 'stable' | 'prerelease'
  published?: string
  ksa?: string
  notes?: string
  /** Hard dependencies: resolved into installs, ranges enforced. */
  required: SourceReference[]
  /** Soft suggestions: never auto-installed, surfaced in the app. */
  recommends: SourceReference[]
  conflicts: { id: string; range: string; reason?: string }[]
  artifacts: SourceArtifact[]
}

export interface SourceArtifact {
  key: string
  platforms: Platform[]
  url: string
  size: number
  sha256: string
  root: string
  installAs: string
}

export class ValidationError extends Error {
  readonly file: string
  constructor(file: string, message: string) {
    super(`${file}: ${message}`)
    this.name = 'ValidationError'
    this.file = file
  }
}

const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function req<T>(file: string, obj: Record<string, unknown>, key: string, type: string): T {
  const v = obj[key]
  if (v === undefined || v === null) throw new ValidationError(file, `missing required key "${key}"`)
  if (type === 'string' && typeof v !== 'string') throw new ValidationError(file, `"${key}" must be a string`)
  if (type === 'number' && typeof v !== 'number') throw new ValidationError(file, `"${key}" must be a number`)
  if (type === 'array' && !Array.isArray(v)) throw new ValidationError(file, `"${key}" must be an array`)
  return v as T
}

function optString(file: string, obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (v === undefined || v === null) return undefined
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'string') throw new ValidationError(file, `"${key}" must be a string`)
  return v
}

function strArray(file: string, obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ValidationError(file, `"${key}" must be an array of strings`)
  }
  return v as string[]
}

export function parseModToml(file: string, text: string): Omit<SourceMod, 'slug' | 'releases' | 'readme'> {
  let doc: Record<string, unknown>
  try {
    doc = parseToml(text) as Record<string, unknown>
  } catch (e) {
    throw new ValidationError(file, `invalid TOML: ${(e as Error).message}`)
  }
  const id = req<string>(file, doc, 'id', 'string')
  if (!MOD_ID_RE.test(id)) throw new ValidationError(file, `id "${id}" is not a valid mod id`)
  const summary = req<string>(file, doc, 'summary', 'string')
  if (summary.length > 400) throw new ValidationError(file, 'summary must be ≤ 400 chars')
  const owners = strArray(file, doc, 'owners')
  if (owners.length === 0) throw new ValidationError(file, 'owners must list at least one GitHub login')
  for (const o of owners) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o)) {
      throw new ValidationError(file, `owner "${o}" is not a valid GitHub login`)
    }
  }
  for (const key of ['repository', 'homepage']) {
    const v = optString(file, doc, key)
    if (v !== undefined && !/^https:\/\//.test(v)) {
      throw new ValidationError(file, `"${key}" must be an https URL`)
    }
  }
  let maxArtifactBytes: number | undefined
  if (doc.max_artifact_bytes !== undefined && doc.max_artifact_bytes !== null) {
    const v = doc.max_artifact_bytes
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new ValidationError(file, '"max_artifact_bytes" must be a positive integer (bytes)')
    }
    if (v > HARD_MAX_ARTIFACT_BYTES) {
      throw new ValidationError(
        file,
        `"max_artifact_bytes" (${v}) exceeds the absolute ceiling of ${HARD_MAX_ARTIFACT_BYTES} bytes (2 GiB)`,
      )
    }
    if (v <= DEFAULT_MAX_ARTIFACT_BYTES) {
      throw new ValidationError(
        file,
        `"max_artifact_bytes" (${v}) is not above the ${DEFAULT_MAX_ARTIFACT_BYTES}-byte default — remove it`,
      )
    }
    maxArtifactBytes = v
  }
  const wcr = doc.who_can_reference
  if (wcr === undefined || wcr === null || typeof wcr !== 'object' || Array.isArray(wcr)) {
    throw new ValidationError(
      file,
      'missing required [who_can_reference] table (use include = [".*"] to allow all mods to reference this one)',
    )
  }
  const wcrObj = wcr as Record<string, unknown>
  const include = strArray(file, wcrObj, 'include')
  const exclude = strArray(file, wcrObj, 'exclude')
  if (include.length === 0) {
    throw new ValidationError(
      file,
      'who_can_reference.include must list at least one pattern (".*" allows all)',
    )
  }
  for (const [key, patterns] of [
    ['include', include],
    ['exclude', exclude],
  ] as const) {
    for (const pattern of patterns) {
      if (pattern.length === 0 || pattern.length > 128) {
        throw new ValidationError(
          file,
          `who_can_reference.${key} patterns must be 1–128 characters`,
        )
      }
      try {
        new RegExp(`^(?:${pattern})$`, 'i')
      } catch (e) {
        throw new ValidationError(
          file,
          `who_can_reference.${key} pattern ${JSON.stringify(pattern)} is not a valid regex: ${(e as Error).message}`,
        )
      }
    }
  }

  let mirrorVersions: number | undefined
  if (doc.mirror_versions !== undefined && doc.mirror_versions !== null) {
    const v = doc.mirror_versions
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 20) {
      throw new ValidationError(file, '"mirror_versions" must be an integer between 0 and 20')
    }
    mirrorVersions = v
  }
  return {
    id,
    name: optString(file, doc, 'name') ?? id,
    summary,
    authors: strArray(file, doc, 'authors'),
    license: optString(file, doc, 'license'),
    repository: optString(file, doc, 'repository'),
    homepage: optString(file, doc, 'homepage'),
    tags: strArray(file, doc, 'tags'),
    owners,
    whoCanReference: { include, exclude },
    maxArtifactBytes,
    mirrorVersions,
  }
}

export function parseReleaseToml(file: string, text: string, modId: string): SourceRelease {
  let doc: Record<string, unknown>
  try {
    doc = parseToml(text) as Record<string, unknown>
  } catch (e) {
    throw new ValidationError(file, `invalid TOML: ${(e as Error).message}`)
  }
  const version = req<string>(file, doc, 'version', 'string')
  if (!SEMVER_RE.test(version)) {
    throw new ValidationError(file, `version "${version}" is not a semver (MAJOR.MINOR.PATCH[-pre])`)
  }
  const channel = optString(file, doc, 'channel') ?? 'stable'
  if (channel !== 'stable' && channel !== 'prerelease') {
    throw new ValidationError(file, `channel must be "stable" or "prerelease"`)
  }
  if (version.includes('-') && channel === 'stable') {
    throw new ValidationError(file, `prerelease version "${version}" must use channel = "prerelease"`)
  }

  if (doc.dependencies !== undefined) {
    throw new ValidationError(
      file,
      'the "dependencies" key was replaced by [[required]] and [[recommends]] tables',
    )
  }
  const parseReferences = (key: 'required' | 'recommends'): SourceReference[] => {
    const out: SourceReference[] = []
    const seen = new Set<string>()
    for (const entry of (doc[key] as Record<string, unknown>[] | undefined) ?? []) {
      const id = req<string>(file, entry, 'id', 'string')
      if (!MOD_ID_RE.test(id)) throw new ValidationError(file, `${key} id "${id}" is invalid`)
      if (id.toLowerCase() === modId.toLowerCase()) {
        throw new ValidationError(file, `a mod cannot ${key === 'required' ? 'require' : 'recommend'} itself`)
      }
      if (seen.has(id.toLowerCase())) {
        throw new ValidationError(file, `duplicate ${key} entry for "${id}"`)
      }
      seen.add(id.toLowerCase())
      const description = optString(file, entry, 'description')
      if (description !== undefined && description.length > 400) {
        throw new ValidationError(file, `${key} description for "${id}" must be ≤ 400 chars`)
      }
      out.push({
        id,
        range: optString(file, entry, 'range') ?? '*',
        ...(description !== undefined ? { description } : {}),
      })
    }
    return out
  }
  const required = parseReferences('required')
  const recommends = parseReferences('recommends')
  for (const r of recommends) {
    if (required.some((q) => q.id.toLowerCase() === r.id.toLowerCase())) {
      throw new ValidationError(file, `"${r.id}" cannot be both required and recommended`)
    }
  }
  const conflicts: SourceRelease['conflicts'] = []
  for (const c of (doc.conflicts as Record<string, unknown>[] | undefined) ?? []) {
    const id = req<string>(file, c, 'id', 'string')
    conflicts.push({ id, range: optString(file, c, 'range') ?? '*', reason: optString(file, c, 'reason') })
  }

  const rawArtifacts = (doc.artifacts as Record<string, unknown>[] | undefined) ?? []
  if (rawArtifacts.length === 0) {
    throw new ValidationError(file, 'a release must declare at least one [[artifacts]] entry')
  }
  const artifacts: SourceArtifact[] = []
  const keys = new Set<string>()
  const claimedPlatforms = new Set<string>()
  for (const a of rawArtifacts) {
    const url = req<string>(file, a, 'url', 'string')
    if (!/^https:\/\//.test(url)) throw new ValidationError(file, `artifact url must be https: ${url}`)
    const size = req<number>(file, a, 'size', 'number')
    if (!Number.isInteger(size) || size <= 0) throw new ValidationError(file, 'artifact size must be a positive integer')
    const sha256 = req<string>(file, a, 'sha256', 'string').toLowerCase()
    if (!SHA256_RE.test(sha256)) throw new ValidationError(file, `artifact sha256 is not a 64-hex digest`)
    const key = optString(file, a, 'key') ?? 'universal'
    if (keys.has(key)) throw new ValidationError(file, `duplicate artifact key "${key}"`)
    keys.add(key)
    let platforms = strArray(file, a, 'platforms')
    if (platforms.length === 0 || platforms.includes('*')) platforms = [...ALL_PLATFORMS]
    for (const p of platforms) {
      if (!ALL_PLATFORMS.includes(p as Platform)) throw new ValidationError(file, `unknown platform "${p}"`)
      if (claimedPlatforms.has(p)) {
        throw new ValidationError(file, `platform "${p}" is claimed by more than one artifact`)
      }
      claimedPlatforms.add(p)
    }
    const installAs = optString(file, a, 'installAs') ?? modId
    if (installAs !== modId) {
      throw new ValidationError(
        file,
        `installAs "${installAs}" must equal the mod id "${modId}" (the StarMap ModId is the folder name)`,
      )
    }
    artifacts.push({
      key,
      platforms: platforms as Platform[],
      url,
      size,
      sha256,
      root: optString(file, a, 'root') ?? modId,
      installAs,
    })
  }

  return {
    file,
    version,
    channel,
    published: optString(file, doc, 'published'),
    ksa: optString(file, doc, 'ksa'),
    notes: optString(file, doc, 'notes'),
    required,
    recommends,
    conflicts,
    artifacts,
  }
}

/** Load and validate the whole mods/ tree. */
export function loadTree(rootDir: string): SourceMod[] {
  const modsDir = join(rootDir, 'mods')
  const mods: SourceMod[] = []
  const seenIds = new Set<string>()
  if (!existsSync(modsDir)) return mods
  for (const slug of readdirSync(modsDir).sort()) {
    const dir = join(modsDir, slug)
    if (!statSync(dir).isDirectory()) {
      throw new ValidationError(`mods/${slug}`, 'unexpected non-directory entry under mods/')
    }
    if (!SLUG_RE.test(slug)) {
      throw new ValidationError(`mods/${slug}`, 'folder name must be a lowercase slug ([a-z0-9._-])')
    }
    const modTomlPath = join(dir, 'mod.toml')
    if (!existsSync(modTomlPath)) throw new ValidationError(`mods/${slug}`, 'missing mod.toml')
    const identity = parseModToml(`mods/${slug}/mod.toml`, readFileSync(modTomlPath, 'utf8'))
    if (identity.id.toLowerCase() !== slug) {
      throw new ValidationError(
        `mods/${slug}/mod.toml`,
        `folder slug "${slug}" must be the lowercase mod id ("${identity.id.toLowerCase()}")`,
      )
    }
    if (seenIds.has(slug)) throw new ValidationError(`mods/${slug}`, `duplicate mod id`)
    seenIds.add(slug)

    const releasesDir = join(dir, 'releases')
    const releases: SourceRelease[] = []
    if (existsSync(releasesDir)) {
      const seenVersions = new Set<string>()
      for (const f of readdirSync(releasesDir).sort()) {
        if (!f.endsWith('.toml')) {
          throw new ValidationError(`mods/${slug}/releases/${f}`, 'only .toml files are allowed here')
        }
        const rel = parseReleaseToml(
          `mods/${slug}/releases/${f}`,
          readFileSync(join(releasesDir, f), 'utf8'),
          identity.id,
        )
        if (f !== `${rel.version}.toml`) {
          throw new ValidationError(
            `mods/${slug}/releases/${f}`,
            `file name must match the version ("${rel.version}.toml")`,
          )
        }
        if (seenVersions.has(rel.version)) {
          throw new ValidationError(`mods/${slug}/releases/${f}`, `duplicate version ${rel.version}`)
        }
        seenVersions.add(rel.version)
        releases.push(rel)
      }
    }

    const readmePath = join(dir, 'README.md')
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : undefined

    // Nothing else may live in a mod folder — keeps PR review surface tight.
    for (const entry of readdirSync(dir)) {
      if (!['mod.toml', 'README.md', 'releases'].includes(entry)) {
        throw new ValidationError(`mods/${slug}/${entry}`, 'unexpected file in mod folder')
      }
    }

    mods.push({ slug, ...identity, readme, releases })
  }

  // Artifact size policy: every artifact must fit the mod's registered
  // ceiling (50 MiB default, mod.toml max_artifact_bytes to override).
  for (const m of mods) {
    const limit = effectiveMaxArtifactBytes(m)
    for (const rel of m.releases) {
      for (const a of rel.artifacts) {
        if (a.size > limit) {
          throw new ValidationError(
            rel.file,
            `artifact "${a.key}" is ${a.size} bytes, above this mod's ${limit}-byte ceiling. ` +
              (m.maxArtifactBytes === undefined
                ? `Large mods must declare max_artifact_bytes in mods/${m.slug}/mod.toml (admin-reviewed).`
                : `Raise max_artifact_bytes in mods/${m.slug}/mod.toml (admin-reviewed).`),
          )
        }
      }
    }
  }

  // Cross-mod checks: reference/conflict targets should exist in the index.
  for (const m of mods) {
    for (const rel of m.releases) {
      for (const d of [...rel.required, ...rel.recommends, ...rel.conflicts]) {
        if (!seenIds.has(d.id.toLowerCase())) {
          throw new ValidationError(
            rel.file,
            `references "${d.id}" which is not in the index (register it first)`,
          )
        }
      }
    }
  }
  return mods
}
