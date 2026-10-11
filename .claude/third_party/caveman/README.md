# Caveman (vendored)

Source: <https://github.com/juliusbrussee/caveman> at commit
`2e08b9177c07bb7249a8a2d1a6758e5db281d002`. Licensed under the Apache License 2.0; see
[LICENSE](LICENSE) and [NOTICE](NOTICE) in this directory.

| Local path                                | Upstream path                     | Changes                                      |
| ----------------------------------------- | --------------------------------- | -------------------------------------------- |
| `.claude/agents/cavecrew-reviewer.md`     | `agents/cavecrew-reviewer.md`     | Modified (see below)                         |
| `.claude/skills/caveman-review/SKILL.md`  | `skills/caveman-review/SKILL.md`  | None                                         |
| `.claude/skills/caveman-review/README.md` | `skills/caveman-review/README.md` | None                                         |
| `.claude/skills/ultracave/SKILL.md`       | `skills/ultracave/SKILL.md`       | None (defines the agent's "Ultracave voice") |

Changes to `cavecrew-reviewer.md`:

- Added a "Reuse & duplication" section: the reviewer searches the repo for existing code that new
  code duplicates and points shared code at this repo's packages.
- Added a "Version bump" section: the reviewer flags shipped changes that don't bump the app
  version (see `AGENTS.md`).
- Loosened the "Boundaries" section to allow extract-and-reuse fixes for duplication.
- Restricted its tools to `Read`, `Grep`, `Glob` and `Bash` (read-only use) so it can search the
  repo but not edit files.

The unmodified files are excluded from Prettier (`.prettierignore`) so they stay byte-identical to
upstream and are easy to update.
