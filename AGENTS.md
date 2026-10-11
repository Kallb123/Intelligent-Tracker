# AGENTS.md

Instructions for AI coding agents working in this repository. See [README.md](README.md) for the
layout and commands, and [docs/PLAN.md](docs/PLAN.md) for the architecture and the PR-by-PR plan.

## Code review: use the Caveman reviewer

Every change you make must be reviewed by the Caveman reviewer before you commit or open a PR.

1. Finish the change and run the fast checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
   `pnpm test`.
2. Run the reviewer over your diff:
   - **Claude Code:** delegate to the `cavecrew-reviewer` subagent
     ([.claude/agents/cavecrew-reviewer.md](.claude/agents/cavecrew-reviewer.md)), e.g. "use
     cavecrew-reviewer to review the diff against main". Without subagents, run the
     `caveman-review` skill ([.claude/skills/caveman-review](.claude/skills/caveman-review/SKILL.md))
     and apply the reuse checks below yourself.
   - **Other agents:** follow `.claude/agents/cavecrew-reviewer.md` as your review instructions;
     it is plain Markdown.
3. Act on the findings:
   - `🔴 bug` and `🟡 risk`: fix them, then review again. Repeat until none are left.
   - `❓ question`: answer it from the code or the task, or ask the user.
   - `🔵 nit`: fix it if it is cheap, otherwise leave it.
4. When you report back or write the PR description, say the review ran and list any findings you
   chose not to fix, with the reason.

The reviewer only reads; it does not edit files. You make the fixes.

## Reuse and maintainability

The reviewer checks for duplication and reuse on every review, and you should write code that
passes that check the first time:

- **Search before you write.** Before adding a function, type, schema, constant, composable or Vue
  component, search the repo for one that already does the job, and reuse or extend it.
- **Put shared code where it belongs**, so the next caller finds it:
  - domain logic (recurrence, rotation, reminder planning) in `packages/core` (pure, no I/O)
  - schemas, types and defaults used by more than one app in `packages/shared`
  - database schema and queries in `packages/db`
  - UI used by more than one view in `apps/web/src/components`, reusable view logic in
    `apps/web/src/composables`
- **Don't hand-write types that already exist.** Import API types from the generated
  `apps/web/src/api/schema.d.ts` and shared types from `@tracker/shared`.
- **Extract on the second copy.** If the same logic appears twice, pull it into one named helper
  or component instead of copying it.
- **Keep components reusable.** Take data through props and events instead of hard-coding it, and
  keep view-specific logic out of generic components.
- **No speculative abstraction.** Don't build a generic layer for a single caller.

## Vendored Caveman files

The reviewer agent and its skills come from
[juliusbrussee/caveman](https://github.com/juliusbrussee/caveman) (Apache-2.0). See
[.claude/third_party/caveman/README.md](.claude/third_party/caveman/README.md) for the source
commit and local changes.
