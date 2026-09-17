# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

**Commit style:** messages are written in French, Conventional-Commits-shaped (`feat(scope): ...`, `fix(scope): ...`), with `scope` a French domain noun matching the touched feature (`messagerie`, `moderation`, `recettes`, `blocages`, `communaute`, `dependencies`, ...). Match this style for consistency with existing history.

**Write a skill when a procedure repeats — don't wait to be asked.** Skills live in `.claude/skills/<name>/SKILL.md` when they are specific to this repo, in `~/.claude/skills/` when the technique would apply to any project. Create one as soon as any of these is true, announcing it in one line rather than asking permission:
- The same non-obvious procedure has had to be explained or corrected across three or more sessions. This is how `migration`, `rgpd` and `visibilite` came to exist.
- The same mistake has been made and repaired twice. The repair belongs in a skill, not in another commit message.
- The user refers to a multi-step procedure as already known ("comme d'habitude", "tu sais faire").

Don't create one for a one-off task, for something a paragraph of this file already covers, or when an existing skill is merely incomplete — extend that skill instead. When a session proves a skill wrong, correct it in the same commit as the code that disproved it.

Match the existing files: written in French, frontmatter with `name`, `user-invocable: true`, and a `description` that states both what the skill does and *when* to reach for it. That sentence is the whole mechanism by which the skill fires on its own later, so it must name the triggering situations rather than summarize the content. Keep the body under ~150 lines, built from real commands and real past failures of this repo rather than generic advice.

**Migration numbering collides across worktrees.** `QueryMysql/migrations/NNN_*.sql` files are numbered sequentially, but parallel feature branches each pick the next number off their own branch, so two branches often claim the same `NNN`. This has caused repeated last-minute renumbering fixups (e.g. `018`/`019`/`020` all collided on 2026-08-21). Before adding a migration, check the highest number on `main`, not just the current branch, and expect to renumber at merge time if another branch landed first.

The `Autom_*` DDL is the exception: it ships with `@benjosivo/automation` (`sql/`), because the DAL that queries it lives there. It never enters this counter — the runner's schema and the application's evolve independently.