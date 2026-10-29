# UI language selection

OMP uses English by default. Set `OMP_LANG=ko` or `OMP_LANG=ko-KR` to opt in to
Korean UI messages. An unset, empty, English, or unsupported value keeps English.

```sh
OMP_LANG=ko omp
```

In PowerShell:

```powershell
$env:OMP_LANG = "ko"
omp
```

Inside the interactive TUI, use `/language ko` or `/language en`. Completion
offers both choices. The command restarts OMP using its existing restart path,
preserves the launch options, and resumes the current session if it has been
saved. Restarting also refreshes UI labels initialized when modules were loaded.
Missing, unsupported, and extra arguments show usage without restarting.

The choice applies to the restarted process. It does not persist a preference
in a settings file or change the parent shell's environment. A separately
launched OMP uses that shell's `OMP_LANG` value or the default English.

## Editable Korean pack

Set `OMP_LOCALE_DIR` to a directory containing `ko.json` to select an external
pack. Source runs otherwise use the package's `locales` directory; compiled
builds look for `locales` beside the executable. This proposal does not add a
new release-distribution pipeline for those assets.

Edit translated values, preserving the English source keys, semantic context
suffixes, and numbered placeholders such as `{0}`. Missing messages fall back
to their English source. An unreadable or invalid pack produces a generic
warning and keeps English without printing rejected contents.

Language packs load only during explicit application initialization. Shared
module imports in SDKs and workers perform no pack I/O, and the Korean catalog
is not statically imported into English bundles. Browser surfaces initialize
from the host-selected messages before loading UI modules.

This feature translates interface text. It does not translate model responses,
past conversation messages, or model-facing tool results. Distribution-specific
installers and update/rebuild tooling remain outside this upstream proposal.
