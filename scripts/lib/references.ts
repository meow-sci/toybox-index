/**
 * Cross-mod reference permissions ("who_can_reference").
 *
 * Mods self-declare `required` and `recommends` references to other mods —
 * which historically (see the CKAN ecosystem) invites drama: authors being
 * "recommended by" mods they want nothing to do with, with no recourse.
 * toybox keeps self-declaration but gives every referenced author an
 * opt-out: mod.toml's REQUIRED `[who_can_reference]` table with `include`
 * and `exclude` regex arrays matched against the REFERRER's mod id (never
 * versions). Exclusions always win. The expected default is include-all
 * (`include = [".*"]`).
 *
 * Matching semantics (deliberately strict and predictable):
 *  - patterns are implicitly anchored (full-match: `^(?:pattern)$`);
 *  - matching is case-insensitive (mod ids are case-preserving but the
 *    ecosystem treats them case-insensitively);
 *  - allowed(referrer) = include.some(match) && !exclude.some(match).
 *
 * Enforcement is split by reference kind:
 *  - a disallowed `recommends` is FILTERED out of the compiled index
 *    (self-declared endorsement the target refused — it simply never
 *    publishes);
 *  - a disallowed `required` is a hard ERROR — silently dropping a hard
 *    dependency would ship broken installs, so the situation (registering
 *    a hard dep on a mod whose author excluded you, or an author excluding
 *    an existing hard dependent) must be resolved by humans.
 */

import type { SourceMod, SourceReference } from './schema.ts'
import { ValidationError } from './schema.ts'

export interface WhoCanReference {
  include: string[]
  exclude: string[]
}

export interface CompiledWhoCanReference {
  include: RegExp[]
  exclude: RegExp[]
}

export const MAX_PATTERN_LENGTH = 128

/**
 * Compile and validate a who_can_reference table. Throws ValidationError
 * (attributed to `file`) on invalid or oversized patterns.
 */
export function compileWhoCanReference(
  file: string,
  who: WhoCanReference,
): CompiledWhoCanReference {
  const compile = (patterns: string[], key: string): RegExp[] =>
    patterns.map((pattern) => {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new ValidationError(file, `who_can_reference.${key} entries must be non-empty strings`)
      }
      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new ValidationError(
          file,
          `who_can_reference.${key} pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
        )
      }
      try {
        // Anchored full-match, case-insensitive.
        return new RegExp(`^(?:${pattern})$`, 'i')
      } catch (e) {
        throw new ValidationError(
          file,
          `who_can_reference.${key} pattern ${JSON.stringify(pattern)} is not a valid regex: ${(e as Error).message}`,
        )
      }
    })
  return { include: compile(who.include, 'include'), exclude: compile(who.exclude, 'exclude') }
}

/** May `referrerId` reference the mod that declared `who`? Exclusions win. */
export function mayReference(who: CompiledWhoCanReference, referrerId: string): boolean {
  const matches = (re: RegExp) => re.test(referrerId)
  if (who.exclude.some(matches)) return false
  return who.include.some(matches)
}

export interface ReferenceViolation {
  file: string
  kind: 'required' | 'recommends'
  from: string
  to: string
  reference: SourceReference
}

export interface ReferenceAudit {
  /** Disallowed `required` references — hard errors. */
  violations: ReferenceViolation[]
  /** Disallowed `recommends` references — filtered from the compiled index. */
  filteredRecommends: ReferenceViolation[]
}

/**
 * Audit every cross-mod reference in the tree against the referenced mods'
 * who_can_reference declarations.
 */
export function auditReferences(mods: readonly SourceMod[]): ReferenceAudit {
  const bySlug = new Map<string, { mod: SourceMod; who: CompiledWhoCanReference }>()
  for (const mod of mods) {
    bySlug.set(mod.slug, {
      mod,
      who: compileWhoCanReference(`mods/${mod.slug}/mod.toml`, mod.whoCanReference),
    })
  }

  const audit: ReferenceAudit = { violations: [], filteredRecommends: [] }
  for (const mod of mods) {
    for (const release of mod.releases) {
      const check = (kind: 'required' | 'recommends', refs: SourceReference[]) => {
        for (const reference of refs) {
          const target = bySlug.get(reference.id.toLowerCase())
          if (!target) continue // existence is validated elsewhere
          if (mayReference(target.who, mod.id)) continue
          const violation: ReferenceViolation = {
            file: release.file,
            kind,
            from: mod.id,
            to: target.mod.id,
            reference,
          }
          if (kind === 'required') audit.violations.push(violation)
          else audit.filteredRecommends.push(violation)
        }
      }
      check('required', release.required)
      check('recommends', release.recommends)
    }
  }
  return audit
}

/** A release's recommends with disallowed entries removed. */
export function allowedRecommends(
  release: { file: string; recommends: SourceReference[] },
  audit: ReferenceAudit,
): SourceReference[] {
  const filtered = new Set(
    audit.filteredRecommends
      .filter((v) => v.file === release.file)
      .map((v) => v.reference),
  )
  return release.recommends.filter((r) => !filtered.has(r))
}
