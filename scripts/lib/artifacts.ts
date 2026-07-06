/**
 * Artifact verification + per-file manifest generation.
 *
 * Downloads each release artifact once, verifies the author-declared sha256
 * (and, for GitHub release assets, cross-checks GitHub's own asset digest),
 * then walks the zip to produce the per-file manifest the app uses for
 * install verification, adoption, and integrity checks.
 *
 * Manifests are cached in cache/manifests/<sha256>.json and (for mirrored
 * releases) verified artifact bytes in cache/artifacts/<sha256>.zip — both
 * content-addressed and persisted between CI runs via actions/cache, so
 * artifacts are downloaded at most once ever.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { SourceArtifact, SourceMod, SourceRelease } from './schema.ts'

export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface ArtifactManifest {
  schema: 1
  modId: string
  version: string
  artifactKey: string
  sha256: string
  files: ManifestFile[]
}

export function manifestCachePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, 'manifests', `${sha256}.json`)
}

export function artifactCachePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, 'artifacts', `${sha256}.zip`)
}

const GH_RELEASE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/

export interface GithubAssetInfo {
  apiUrl: string
  digest?: string
}

/** Look up the GitHub API asset URL (and server-side digest) for a release download URL. */
export async function lookupGithubAsset(
  url: string,
  token?: string,
): Promise<GithubAssetInfo | null> {
  const m = GH_RELEASE_RE.exec(url)
  if (!m) return null
  const [, owner, repo, tag, file] = m
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag!)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  )
  if (!res.ok) return null
  const release = (await res.json()) as {
    assets?: { name: string; url: string; digest?: string | null }[]
  }
  const asset = release.assets?.find((a) => a.name === decodeURIComponent(file!))
  if (!asset) return null
  return { apiUrl: asset.url, digest: asset.digest ?? undefined }
}

export class ArtifactError extends Error {}

/**
 * Download an artifact with streaming size enforcement and full digest
 * verification (cross-checked against GitHub's asset digest when available).
 */
async function downloadVerified(
  release: SourceRelease,
  artifact: SourceArtifact,
  opts: { token?: string; log?: (msg: string) => void } = {},
): Promise<Uint8Array> {
  const log = opts.log ?? (() => {})
  // Cross-check GitHub's own digest before spending the download, when available.
  const gh = await lookupGithubAsset(artifact.url, opts.token)
  if (gh?.digest) {
    const serverDigest = gh.digest.replace(/^sha256:/, '').toLowerCase()
    if (serverDigest !== artifact.sha256) {
      throw new ArtifactError(
        `${release.file}: declared sha256 ${artifact.sha256} does not match GitHub's asset digest ${serverDigest} for ${artifact.url}`,
      )
    }
  }

  log(`  downloading ${artifact.url} (${(artifact.size / 1024 / 1024).toFixed(1)} MB)…`)
  const res = await fetch(artifact.url, { redirect: 'follow' })
  if (!res.ok) throw new ArtifactError(`${release.file}: HTTP ${res.status} downloading ${artifact.url}`)
  if (!res.body) throw new ArtifactError(`${release.file}: empty response body from ${artifact.url}`)
  // Self-protection: never buffer past the declared size (which schema
  // validation has already capped by the mod's registered ceiling) — abort
  // the stream the moment a server over-sends instead of trusting
  // Content-Length or buffering unbounded data.
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > artifact.size) {
      await reader.cancel().catch(() => {})
      throw new ArtifactError(
        `${release.file}: ${artifact.url} sent more than the declared ${artifact.size} bytes — aborted`,
      )
    }
    chunks.push(value)
  }
  if (received !== artifact.size) {
    throw new ArtifactError(
      `${release.file}: ${artifact.url} is ${received} bytes, declared ${artifact.size}`,
    )
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) {
    throw new ArtifactError(
      `${release.file}: sha256 mismatch for ${artifact.url}: declared ${artifact.sha256}, actual ${digest}`,
    )
  }
  return bytes
}

/**
 * Ensure the verified artifact bytes exist in the content-addressed cache
 * (for mirroring into the published site). Returns the cache path.
 */
export async function ensureArtifactCached(
  release: SourceRelease,
  artifact: SourceArtifact,
  cacheDir: string,
  opts: { token?: string; log?: (msg: string) => void } = {},
): Promise<string> {
  const path = artifactCachePath(cacheDir, artifact.sha256)
  if (existsSync(path)) return path
  const bytes = await downloadVerified(release, artifact, opts)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/**
 * Verify one artifact and produce its manifest (from cache when available).
 * With keepArtifact, the verified bytes are also stored in the artifact
 * cache so a subsequent mirror step needs no second download.
 */
export async function verifyAndManifest(
  mod: SourceMod,
  release: SourceRelease,
  artifact: SourceArtifact,
  cacheDir: string,
  opts: { token?: string; log?: (msg: string) => void; keepArtifact?: boolean } = {},
): Promise<ArtifactManifest> {
  const log = opts.log ?? (() => {})
  const cached = manifestCachePath(cacheDir, artifact.sha256)
  if (existsSync(cached)) {
    log(`  manifest cache hit for ${artifact.url}`)
    const manifest = JSON.parse(readFileSync(cached, 'utf8')) as ArtifactManifest
    return { ...manifest, modId: mod.id, version: release.version, artifactKey: artifact.key }
  }

  const bytes = await downloadVerified(release, artifact, opts)
  if (opts.keepArtifact) {
    const artifactPath = artifactCachePath(cacheDir, artifact.sha256)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, bytes)
  }

  const entries = unzipSync(bytes)
  const rootPrefix = artifact.root.replace(/\/+$/, '')
  const files: ManifestFile[] = []
  let sawRoot = false
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new ArtifactError(`${release.file}: unsafe path "${name}" inside ${artifact.url}`)
    }
    let rel: string
    if (rootPrefix === '') rel = name
    else if (name.startsWith(`${rootPrefix}/`)) {
      rel = name.slice(rootPrefix.length + 1)
      sawRoot = true
    } else {
      throw new ArtifactError(
        `${release.file}: ${artifact.url} contains "${name}" outside the declared root "${artifact.root}/" — toybox artifacts must contain exactly one top-level mod folder`,
      )
    }
    if (rel.length === 0) continue
    files.push({ path: rel, size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
  }
  if (rootPrefix !== '' && !sawRoot) {
    throw new ArtifactError(
      `${release.file}: ${artifact.url} has no entries under the declared root "${artifact.root}/"`,
    )
  }
  if (!files.some((f) => f.path === 'mod.toml')) {
    throw new ArtifactError(
      `${release.file}: ${artifact.url} does not contain ${artifact.root}/mod.toml — not a KSA mod archive`,
    )
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))

  const manifest: ArtifactManifest = {
    schema: 1,
    modId: mod.id,
    version: release.version,
    artifactKey: artifact.key,
    sha256: artifact.sha256,
    files,
  }
  mkdirSync(dirname(cached), { recursive: true })
  writeFileSync(cached, JSON.stringify(manifest))
  log(`  verified ${files.length} files, manifest cached`)
  return manifest
}
