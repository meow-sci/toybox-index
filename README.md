# toybox-index

The community metadata index behind **[toybox](https://github.com/meow-sci/toybox)**,
the browser-only mod manager for Kitten Space Agency.

Humans author small TOML files here; CI verifies everything (schemas, artifact
sha256 digests — cross-checked against GitHub's own asset digests — and
per-file manifests generated from the real archives) and publishes the
compiled index to GitHub Pages:

```
v1/index.json                        the catalog (identity, releases, readmes)
v1/manifests/<slug>/<v>.<key>.json   per-file sha256 manifests per artifact
```

## Registering a mod

Open a PR adding one folder:

```
mods/<your-mod-id-lowercase>/
  mod.toml          identity + owners (see below)
  README.md         rich markdown, rendered inside the toybox app
  releases/
    <version>.toml  one file per release
```

`mod.toml`:

```toml
id = "MyMod"            # your StarMap ModId — the mod folder name in mods/
name = "MyMod"
summary = "One or two sentences shown in search results."
authors = ["You"]
license = "MIT"
repository = "https://github.com/you/mymod"
tags = ["utility"]
owners = ["your-github-login"]   # who may self-publish releases
```

`releases/1.0.0.toml`:

```toml
version = "1.0.0"
channel = "stable"
published = "2026-07-05T12:00:00Z"
# ksa = ">=2026.7"     # optional KSA compatibility range

[[artifacts]]
platforms = ["*"]      # or split per platform with key = "windows" / "linux"
url = "https://github.com/you/mymod/releases/download/v1.0.0/MyMod-1.0.0.zip"
size = 123456
sha256 = "…64 hex chars…"
root = "MyMod"         # the single top-level folder inside the zip
```

Conventions (validated by CI):
- the zip contains **exactly one top-level folder named after your ModId**,
  with `mod.toml` inside it — exactly what `zip -r MyMod-1.0.0.zip MyMod` produces;
- the folder slug here is the lowercase mod id; the release file name is
  `<version>.toml`; versions are semver;
- the sha256 is of the zip itself (GitHub shows it as the asset digest, or run
  `sha256sum MyMod-1.0.0.zip`).

Dependencies (optional) map 1:1 onto StarMap semantics plus a version range:

```toml
[[dependencies]]
id = "purrTTY"
range = "^1.0"
optional = true        # StarMap Optional: loads without it, validated when present
```

## Governance — how publishing works

- **New mod registration** (a PR creating `mods/<slug>/`): reviewed by the
  toybox admin team. This is where identity is established.
- **Releases and metadata updates to your own mod**: once you are in that
  mod's `owners`, your PRs are validated and **auto-merged by CI** — schema,
  digest verification against the live artifact, per-file manifest
  generation, and an ownership check (owners are read from the *base* branch,
  so a PR cannot grant itself rights). No org membership needed, no waiting
  on humans.
- **Changing `owners`, or touching anything outside `mods/**`**: admin review.

`CODEOWNERS` is generated (`npm run codeowners`) — GitHub only honors
code-owner entries for users with write access, so per-mod ownership is
enforced by the validation bot instead, with CODEOWNERS routing everything
else to the admin team.

## Local development

```bash
npm install
npm run validate               # schema + cross-reference checks
node scripts/validate.ts --artifacts   # + download & verify every artifact
npm run compile                # build dist/v1 (full)
node scripts/compile.ts --skip-artifacts  # fast, no downloads/manifests
npm run codeowners             # regenerate CODEOWNERS
```

Scripts run on Node ≥ 24 (TypeScript type stripping — no build step).
