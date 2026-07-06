# toybox-index

The community metadata index behind **[toybox](https://github.com/meow-sci/toybox)**,
the browser-only mod manager for Kitten Space Agency.

Humans author small TOML files here; CI verifies everything (schemas, artifact
sha256 digests — cross-checked against GitHub's own asset digests — and
per-file manifests generated from the real archives) and publishes the
compiled index to GitHub Pages:

```
v1/index.json                              the central catalog: identity, summaries,
                                           tags, releases — everything searchable
v1/mods/<slug>/readme.md                   rich markdown, lazy-fetched by the app
v1/mods/<slug>/manifests/<v>.<key>.json    per-file sha256 manifests per artifact
v1/mods/<slug>/artifacts/<v>.<key>.zip     mirrored artifact bytes for the mod's
                                           newest mirror_versions releases
```

The layout is maven-style: one small discovery document plus convention-based
per-mod files fetched on demand, so the index download stays tiny no matter
how large the catalog grows.

The published tree is also **human-browsable**: every directory gets a
generated `index.html` — fully self-contained HTML+CSS, no JavaScript, no
external requests — with breadcrumb navigation, folder traversal, and
per-file view/download links, like a classic autoindex or maven repository
browser.

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
  `sha256sum MyMod-1.0.0.zip`);
- **artifacts are capped at 50 MiB by default.** A mod that genuinely ships
  bigger payloads declares a higher ceiling in its `mod.toml`:

  ```toml
  max_artifact_bytes = 209715200 # 200 MiB
  ```

  The ceiling is registration-level: setting or changing it requires admin
  review (like `owners` changes — a release PR cannot raise its own limit),
  and there is an absolute 2 GiB maximum no metadata can override. CI also
  aborts any artifact download the moment it exceeds the declared size, so
  over-sending servers or false size claims cannot make CI buffer unbounded
  data;
- **mirroring** — GitHub release downloads are not fetchable from browsers
  (no CORS on the redirect chain), so the publish pipeline mirrors each
  mod's newest releases into the Pages site, where the toybox app downloads
  them same-origin:

  ```toml
  mirror_versions = 5    # newest N releases mirrored; 0/absent = none
  ```

  Also registration-level and admin-reviewed — the Pages site has a ~1 GB
  budget, so mirror allocation is rationed by the admin team. Un-mirrored
  releases still work everywhere via the app's guided-download fallback.

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
- **Changing `owners`, `max_artifact_bytes`, or `mirror_versions`, or
  touching anything outside `mods/**`**: admin review.

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
