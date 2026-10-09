# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge with the existing entry.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-10-08
- Context: Discovered by Agent while performing the ONLY-READ build-chain bug review (scripts/ + workflows)
- Category: Environment Configuration
- Instructions:
  - This sandbox has no `python` command (only `python3` at /usr/bin/python3) and no `pwsh`; build-snapshot-013.mjs / build-apk.mjs hardcode `python`, so local Linux verification of those scripts must go through a `python`->`python3` shim or WSL, not direct execution.
  - The monkeycode websearch MCP tools fail with "insufficient balance" and github.com/actions/runner-images raw README URLs 404; use local repro in /tmp plus webfetch of raw.githubusercontent.com URLs for external fact checks.
  - Node here is v22.22.0; node exits 0 on stdout EPIPE (verified), so `cmd | Select-Object -First N` early-close does not by itself cause non-zero exit codes for node-based gate scripts.

[Project Knowledge Summary]
- Date: 2026-10-08
- Context: Discovered by Agent while verifying asset-manifest counting semantics with a duplicate-member tar fixture
- Category: Troubleshooting & Debugging
- Instructions:
  - To reproduce the fileBytes dedup asymmetry: build a tar with a duplicated file member (`tar --append`), run `node scripts/gen-asset-manifest.mjs <assetsDir>`, and compare manifest rootfsStats.fileBytes against a real extraction walk; uniquePaths dedups but fileBytes does not, so bytes lower-bound can fail while members passes.
