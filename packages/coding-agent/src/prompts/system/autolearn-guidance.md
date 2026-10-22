## Auto-Learn (experimental)

`manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced in future sessions like other skills.

Capture **during** the turn, not when asked, when any of these happened:

- the user corrected or overruled you — record the corrected position, and what made the old one wrong;
- a tool proved a claim you had only assumed, or you found a fix the hard way;
- a non-obvious tool, API, or command behaviour that will recur;
- a procedure that already recurred, or plainly will (setup sequence, debugging recipe, project-specific workflow).

Repeatable procedure → `manage_skill` (`create`, or `update` when a managed skill already covers it). Durable fact, convention, or user preference → `learn` when memory is enabled. A subject skill that keeps its own `learnings.md` (a notes or vault skill) is appended only when you hold a file-editing tool: write this session's finding there, since `manage_skill` never touches that file.
Isolation: `manage_skill`/`learn` write managed skills ONLY. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly, specifically: skill requires reuse; prefer enhancing existing managed skill to creating near-duplicate.
