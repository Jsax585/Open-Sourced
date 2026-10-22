Managed skill: `SKILL.md` in an isolated omp-owned store; surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

`scope`: `global` (default) → every session; `project` → only sessions in this repository. Repo-specific procedure → `project`.
`update`/`delete` without `scope` → the copy this session sees (project if present, else global); explicit `scope` → that store only.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
