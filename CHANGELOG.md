# Changelog

## 0.1.1 - 2026-05-12

- Fix Codex event parsing so `event_msg` user prompts count as user rounds.
- Redact sensitive text from extracted memory and structured tool inputs.
- Detect same-size transcript rewrites with content hashes before reusing cached mapping/status.
- Preserve manual Canvas edges that connect to generated nodes during regeneration.
- Keep generated Markdown deterministic for repeated applies against the same transcript evidence.
- Add deep regression coverage for rich Codex/Claude fixtures, privacy, cache freshness, merge conflicts, Canvas preservation, and corrupt Canvas handling.

## 0.1.0 - 2026-05-12

- Add the initial Agent Mindmap Obsidian plugin MVP.
- Scan local Codex and Claude Code transcripts into a shared session inbox.
- Map sessions to project-scoped memory folders.
- Extract heuristic project memory with trace evidence.
- Gate Markdown writes behind explicit manual confirmation.
- Generate project-scoped Obsidian Canvas maps after a successful merge.
- Persist reviewed and merged session status across refreshes.
