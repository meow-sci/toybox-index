/**
 * Generate CODEOWNERS from the owners lists in each mods/<slug>/mod.toml.
 *
 * GitHub only honors CODEOWNERS entries for users with write access, and mod
 * publishers are deliberately NOT org members — so per-mod owners cannot be
 * real CODEOWNERS entries (GitHub would flag them as errors). Instead:
 *
 *  - the admin team owns everything (review routing for what the bot won't
 *    merge: new mods, owner changes, scripts/workflows);
 *  - per-mod ownership lives in each mod.toml `owners` and is enforced by
 *    validate.ts in the auto-merge pipeline;
 *  - this file documents that mapping as comments, so `git blame`-style
 *    questions have one answer.
 *
 * Usage: node scripts/gen-codeowners.ts [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { loadTree } from './lib/schema.ts'

const ADMIN_TEAM = '@meow-sci/toybox-admins'

const mods = loadTree(process.cwd())
let out = `# GENERATED FILE — regenerate with: npm run codeowners
#
# The admin team reviews everything the publish bot does not auto-merge
# (new mod registrations, owners changes, scripts/ and workflow changes).
# Per-mod publishing rights are data, not CODEOWNERS entries: each mod's
# owners are listed in mods/<slug>/mod.toml and enforced by
# scripts/validate.ts in the auto-merge workflow (publishers are not org
# members, so GitHub CODEOWNERS cannot grant them review power).

* ${ADMIN_TEAM}

# Per-mod publishers (informational; enforced by the bot):
`
for (const mod of mods) {
  out += `#   mods/${mod.slug}/ → ${mod.owners.map((o) => `@${o}`).join(' ')}\n`
}

if (process.argv.includes('--check')) {
  const current = readFileSync('CODEOWNERS', 'utf8')
  if (current !== out) {
    console.error('CODEOWNERS is out of date — run: npm run codeowners')
    process.exit(1)
  }
  console.log('✓ CODEOWNERS is current')
} else {
  writeFileSync('CODEOWNERS', out)
  console.log('✓ wrote CODEOWNERS')
}
