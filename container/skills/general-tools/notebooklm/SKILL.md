---
name: notebooklm
description: Use the NotebookLM CLI (`nlm`) and MCP server from MatClaw agent containers. Trigger on "NotebookLM", "notebook lm", "nlm", or "notebooklm-mcp".
---

# NotebookLM CLI (`nlm`)

The MatClaw agent image includes `notebooklm-mcp-cli`, which provides:

- `nlm`
- `notebooklm-mcp`

Do not install these tools during normal tasks. They are preinstalled and on
`PATH`.

## Auth

NotebookLM auth is persisted by the MatClaw controller and mounted into every
agent container at:

- `/home/node/.nlm`
- `/home/node/.notebooklm-mcp-cli`

Before using NotebookLM, check auth:

```bash
nlm login --check
```

If auth has expired, run:

```bash
nlm login
```

The CLI has automatic auth recovery: it can reload refreshed tokens from disk
and can use saved browser login state for headless auth when available. Do not
delete the auth directories unless the user explicitly asks; deleting them will
break persistence for future MatClaw runs.

## Commands

Useful starting points:

```bash
nlm --help
nlm --ai
nlm doctor
nlm notebook list
nlm notebook query <notebook-id> "question"
```

Avoid `nlm chat start` in autonomous runs because it opens an interactive REPL.
Use `nlm notebook query` for one-shot questions.

Deletion commands are irreversible. Ask the user before running any `delete`
command, even if `--confirm` is available.
