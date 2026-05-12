# Agent Mindmap

Agent Mindmap is an Obsidian plugin MVP for turning local AI coding sessions into project memory.

It scans local Codex and Claude Code JSONL transcripts, normalizes them into a shared Session/Message schema, lets you review a merge preview, writes project Markdown files after explicit confirmation, and generates a project-scoped Obsidian Canvas map with evidence references.

## Install for Local Testing

1. Run `npm install`.
2. Run `npm run build`.
3. Copy or symlink this folder into an Obsidian vault under `.obsidian/plugins/agent-mindmap`.
4. Enable `Agent Mindmap` in Obsidian community plugins.
5. Open the ribbon action or command `Open AI Sessions view`.

Required plugin files are:

- `manifest.json`
- `main.js`
- `styles.css`

## Configure

Open the plugin settings and review:

- Memory root: vault-relative folder for project Markdown, cache, previews, and Canvas files.
- Codex session roots: defaults to `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Claude Code project roots: defaults to `~/.claude/projects`.
- Project mapping policy: MVP maps by transcript cwd/source path into a stable project id.
- Manual merge only: keeps project Markdown writes behind `Confirm Apply`.
- Privacy filters: removes injected context and secret-like text from transcript previews and evidence.
- Cache diagnostics: shows recent scan diagnostics and recovery labels.

## Workflow

1. Run `Refresh` or command `Scan Codex and Claude Code sessions`.
2. Select a session in the Inbox.
3. Use `Map to Project` to preview the cwd-based project mapping.
4. Use `Extract Memory` to create a merge preview JSON under `AI-Projects/_inbox/`.
5. Open the `Memory` tab to review target files, warnings, conflicts, and evidence.
6. Use `Confirm Apply` to write Markdown files. Existing non-identical files are treated as conflicts and are not overwritten.
7. Use `Generate Canvas` only after a successful apply. Canvas nodes link to Markdown files and carry evidence metadata.

## MVP Boundaries

This MVP does not implement Claude Web sync, mobile support, multi-user collaboration, fully automatic merge, or a complete task-board system.

Markdown and JSON are the durable state source. Canvas is generated navigation only.
