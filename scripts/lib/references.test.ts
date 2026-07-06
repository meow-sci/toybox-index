/**
 * Unit tests for the who_can_reference permission engine.
 * Run: npm test  (node --test, native type stripping)
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allowedRecommends,
  auditReferences,
  compileWhoCanReference,
  mayReference,
} from './references.ts'
import { parseModToml, parseReleaseToml, ValidationError } from './schema.ts'
import type { SourceMod, SourceReference } from './schema.ts'

const who = (include: string[], exclude: string[] = []) =>
  compileWhoCanReference('test/mod.toml', { include, exclude })

describe('compileWhoCanReference', () => {
  it('compiles valid patterns', () => {
    const c = who(['.*'], ['gat.*'])
    assert.equal(c.include.length, 1)
    assert.equal(c.exclude.length, 1)
  })

  it('rejects invalid regex with the file attributed', () => {
    assert.throws(
      () => who(['[unclosed']),
      (e: Error) =>
        e instanceof ValidationError &&
        e.message.includes('test/mod.toml') &&
        e.message.includes('not a valid regex'),
    )
  })

  it('rejects empty and oversized patterns', () => {
    assert.throws(() => who(['']), ValidationError)
    assert.throws(() => who(['a'.repeat(129)]), ValidationError)
    assert.doesNotThrow(() => who(['a'.repeat(128)]))
  })
})

describe('mayReference', () => {
  it('include-all allows anyone', () => {
    assert.equal(mayReference(who(['.*']), 'AnyMod'), true)
    assert.equal(mayReference(who(['.*']), 'x'), true)
  })

  it('exclusions ALWAYS win over inclusions', () => {
    const c = who(['.*'], ['SpamMod'])
    assert.equal(mayReference(c, 'NiceMod'), true)
    assert.equal(mayReference(c, 'SpamMod'), false)
    // Both lists match explicitly — exclude still wins.
    const both = who(['SpamMod'], ['SpamMod'])
    assert.equal(mayReference(both, 'SpamMod'), false)
  })

  it('patterns are full-match (implicitly anchored)', () => {
    const c = who(['gat'])
    assert.equal(mayReference(c, 'gat'), true)
    assert.equal(mayReference(c, 'gatOS'), false) // substring is NOT enough
    assert.equal(mayReference(c, 'mygat'), false)
    const wild = who(['gat.*'])
    assert.equal(mayReference(wild, 'gatOS'), true)
    assert.equal(mayReference(wild, 'mygatOS'), false) // no implicit prefix match
  })

  it('matching is case-insensitive', () => {
    assert.equal(mayReference(who(['purrtty']), 'purrTTY'), true)
    assert.equal(mayReference(who(['.*'], ['PURRTTY']), 'purrtty'), false)
  })

  it('empty include (unreachable via schema) allows nobody', () => {
    assert.equal(mayReference(who([], []), 'AnyMod'), false)
  })

  it('alternation and character classes work', () => {
    const c = who(['gatOS|purrTTY', 'meow-.*'])
    assert.equal(mayReference(c, 'gatOS'), true)
    assert.equal(mayReference(c, 'purrTTY'), true)
    assert.equal(mayReference(c, 'meow-tools'), true)
    assert.equal(mayReference(c, 'other'), false)
  })

  it('regex metacharacters in ids do not grant accidental matches', () => {
    // A pattern of a literal id containing a dot must not match variants…
    const c = who(['mod\\.name'])
    assert.equal(mayReference(c, 'mod.name'), true)
    assert.equal(mayReference(c, 'modxname'), false)
    // …while an unescaped dot does (regex semantics, as documented).
    assert.equal(mayReference(who(['mod.name']), 'modxname'), true)
  })
})

// ---------------------------------------------------------------------------
// Tree-level auditing
// ---------------------------------------------------------------------------

function makeMod(
  id: string,
  opts: {
    include?: string[]
    exclude?: string[]
    required?: SourceReference[]
    recommends?: SourceReference[]
  } = {},
): SourceMod {
  return {
    slug: id.toLowerCase(),
    id,
    name: id,
    summary: `${id} summary`,
    authors: [],
    tags: [],
    owners: ['someone'],
    whoCanReference: { include: opts.include ?? ['.*'], exclude: opts.exclude ?? [] },
    releases: [
      {
        file: `mods/${id.toLowerCase()}/releases/1.0.0.toml`,
        version: '1.0.0',
        channel: 'stable',
        required: opts.required ?? [],
        recommends: opts.recommends ?? [],
        conflicts: [],
        artifacts: [
          {
            key: 'universal',
            platforms: ['windows', 'linux', 'macos'],
            url: `https://example.com/${id}.zip`,
            size: 1,
            sha256: 'a'.repeat(64),
            root: id,
            installAs: id,
          },
        ],
      },
    ],
  }
}

describe('auditReferences', () => {
  it('passes a clean tree', () => {
    const audit = auditReferences([
      makeMod('Lib'),
      makeMod('App', { required: [{ id: 'Lib', range: '^1.0' }] }),
    ])
    assert.deepEqual(audit.violations, [])
    assert.deepEqual(audit.filteredRecommends, [])
  })

  it('flags a disallowed REQUIRED reference as a violation', () => {
    const audit = auditReferences([
      makeMod('Lib', { exclude: ['App'] }),
      makeMod('App', { required: [{ id: 'Lib', range: '*' }] }),
    ])
    assert.equal(audit.violations.length, 1)
    assert.deepEqual(
      { from: audit.violations[0]!.from, to: audit.violations[0]!.to, kind: audit.violations[0]!.kind },
      { from: 'App', to: 'Lib', kind: 'required' },
    )
  })

  it('flags a disallowed RECOMMENDS reference for filtering (not violation)', () => {
    const audit = auditReferences([
      makeMod('Popular', { exclude: ['Spam.*'] }),
      makeMod('SpamPack', { recommends: [{ id: 'Popular', range: '*' }] }),
    ])
    assert.equal(audit.violations.length, 0)
    assert.equal(audit.filteredRecommends.length, 1)
    assert.equal(audit.filteredRecommends[0]!.from, 'SpamPack')
  })

  it('honors include allowlists (only listed ids may reference)', () => {
    const audit = auditReferences([
      makeMod('Core', { include: ['Blessed'] }),
      makeMod('Blessed', { recommends: [{ id: 'Core', range: '*' }] }),
      makeMod('Rando', { recommends: [{ id: 'Core', range: '*' }] }),
    ])
    assert.equal(audit.filteredRecommends.length, 1)
    assert.equal(audit.filteredRecommends[0]!.from, 'Rando')
  })

  it('resolves reference targets case-insensitively', () => {
    const audit = auditReferences([
      makeMod('purrTTY', { exclude: ['gatOS'] }),
      makeMod('gatOS', { recommends: [{ id: 'PURRTTY', range: '*' }] }),
    ])
    assert.equal(audit.filteredRecommends.length, 1)
  })

  it('audits every release of a mod, not just the newest', () => {
    const lib = makeMod('Lib', { exclude: ['App'] })
    const app = makeMod('App', { recommends: [{ id: 'Lib', range: '*' }] })
    app.releases.push({
      ...app.releases[0]!,
      file: 'mods/app/releases/2.0.0.toml',
      version: '2.0.0',
    })
    const audit = auditReferences([lib, app])
    assert.equal(audit.filteredRecommends.length, 2)
  })

  it('ignores references to mods outside the tree (existence checked elsewhere)', () => {
    const audit = auditReferences([makeMod('App', { required: [{ id: 'Ghost', range: '*' }] })])
    assert.deepEqual(audit.violations, [])
  })

  it('a mod may always reference itself-adjacent ids that merely LOOK similar', () => {
    const audit = auditReferences([
      makeMod('Lib', { exclude: ['Application'] }),
      makeMod('App', { required: [{ id: 'Lib', range: '*' }] }),
    ])
    assert.deepEqual(audit.violations, []) // 'App' ≠ 'Application' under full-match
  })
})

describe('allowedRecommends', () => {
  it('filters exactly the disallowed entries of the right release', () => {
    const lib = makeMod('Lib', { exclude: ['App'] })
    const ok = makeMod('Nice', {})
    const app = makeMod('App', {
      recommends: [
        { id: 'Lib', range: '*' },
        { id: 'Nice', range: '^1.0', description: 'plays well together' },
      ],
    })
    const audit = auditReferences([lib, ok, app])
    const kept = allowedRecommends(app.releases[0]!, audit)
    assert.deepEqual(kept, [{ id: 'Nice', range: '^1.0', description: 'plays well together' }])
    // A different release's recommends are untouched by this release's filter.
    const untouched = allowedRecommends(ok.releases[0]!, audit)
    assert.deepEqual(untouched, [])
  })
})

// ---------------------------------------------------------------------------
// Schema-level parsing of the new fields
// ---------------------------------------------------------------------------

const MOD_TOML = (extra: string) => `
id = "TestMod"
summary = "s"
owners = ["someone"]
${extra}
`

describe('parseModToml: who_can_reference', () => {
  it('is REQUIRED', () => {
    assert.throws(
      () => parseModToml('m.toml', MOD_TOML('')),
      (e: Error) => e.message.includes('who_can_reference'),
    )
  })

  it('requires a non-empty include', () => {
    assert.throws(
      () => parseModToml('m.toml', MOD_TOML('[who_can_reference]\ninclude = []')),
      (e: Error) => e.message.includes('at least one pattern'),
    )
  })

  it('exclude defaults to empty', () => {
    const m = parseModToml('m.toml', MOD_TOML('[who_can_reference]\ninclude = [".*"]'))
    assert.deepEqual(m.whoCanReference, { include: ['.*'], exclude: [] })
  })

  it('rejects invalid regex patterns at registration time', () => {
    assert.throws(
      () =>
        parseModToml(
          'm.toml',
          MOD_TOML('[who_can_reference]\ninclude = [".*"]\nexclude = ["(unclosed"]'),
        ),
      (e: Error) => e.message.includes('not a valid regex'),
    )
  })
})

const RELEASE_TOML = (extra: string) => `
version = "1.0.0"
${extra}

[[artifacts]]
platforms = ["*"]
url = "https://example.com/a.zip"
size = 10
sha256 = "${'a'.repeat(64)}"
`

describe('parseReleaseToml: required/recommends', () => {
  it('parses rich reference entries', () => {
    const r = parseReleaseToml(
      'r.toml',
      RELEASE_TOML(
        '[[required]]\nid = "Lib"\nrange = "^1.0"\ndescription = "core physics"\n\n[[recommends]]\nid = "Extra"',
      ),
      'TestMod',
    )
    assert.deepEqual(r.required, [{ id: 'Lib', range: '^1.0', description: 'core physics' }])
    assert.deepEqual(r.recommends, [{ id: 'Extra', range: '*' }])
  })

  it('rejects the retired dependencies key with a pointer to the new model', () => {
    assert.throws(
      () => parseReleaseToml('r.toml', RELEASE_TOML('[[dependencies]]\nid = "Lib"'), 'TestMod'),
      (e: Error) => e.message.includes('[[required]] and [[recommends]]'),
    )
  })

  it('rejects self-references, duplicates, and both-lists membership', () => {
    assert.throws(
      () => parseReleaseToml('r.toml', RELEASE_TOML('[[required]]\nid = "TestMod"'), 'TestMod'),
      (e: Error) => e.message.includes('cannot require itself'),
    )
    assert.throws(
      () =>
        parseReleaseToml(
          'r.toml',
          RELEASE_TOML('[[recommends]]\nid = "Lib"\n\n[[recommends]]\nid = "lib"'),
          'TestMod',
        ),
      (e: Error) => e.message.includes('duplicate'),
    )
    assert.throws(
      () =>
        parseReleaseToml(
          'r.toml',
          RELEASE_TOML('[[required]]\nid = "Lib"\n\n[[recommends]]\nid = "Lib"'),
          'TestMod',
        ),
      (e: Error) => e.message.includes('both required and recommended'),
    )
  })

  it('caps description length', () => {
    assert.throws(
      () =>
        parseReleaseToml(
          'r.toml',
          RELEASE_TOML(`[[required]]\nid = "Lib"\ndescription = "${'x'.repeat(401)}"`),
          'TestMod',
        ),
      (e: Error) => e.message.includes('≤ 400'),
    )
  })
})
