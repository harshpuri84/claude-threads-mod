# Threads

A Claude Code mod that turns one chat into the lead of a small team. The lead starts helpers on the model you name, tracks them in a side pane, and gathers their results.

- **Claude helpers.** Real sessions in the desktop app sidebar, on the model and effort you choose.
- **Codex and Cursor helpers.** `codex exec` and `cursor-agent -p` runs in the background. Codex roles: build (`gpt-6.1-sol`), review (`gpt-6-astra`, read-only), image (`gpt-6-luna` with Codex image generation). Cursor takes any model id. Each run also gets a small Haiku watcher session in the sidebar, which follows the log and reports the result back to the lead. Runs keep going through mod reloads.
- **Codex computer use.** The `cua` tool drives Mac apps in the background through Codex's `cua_repl`, without moving your cursor. Each app asks once in the pane: Allow for this chat, Always allow, or Deny.
- **The pane.** State, model, effort, last activity and context per helper; Ask status, Stop, Steer all, Gather results; your Claude plan usage.

## Install

At the prompt of a terminal session:

```
/plugin install threads --marketplace harshpuri84/claude-threads-mod
```

From a shell:

```bash
claude plugin install threads --marketplace harshpuri84/claude-threads-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `harshpuri84/claude-threads-mod`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope.

## Requirements

- macOS and the Claude desktop app (Claude helpers use its session tools).
- For Codex helpers: the Codex CLI, signed in. For Cursor helpers: `cursor-agent`, signed in.
- For computer use: the ChatGPT desktop app with Codex computer use set up, opened at least once.

## Use

Ask the chat, for example: "Start two threads: a Haiku thread at low effort that lists the top-level folders, and a Codex review on Astra of `src/`. Then gather the results." Type `/threads` to open the pane.

Files the mod writes: `~/.claude/mcp/threads-runs/<id>/` per Codex or Cursor run, and `~/.claude/mcp/codex-cu/` for the computer-use helper and your Always allow list.

## Credits

The computer-use helper (`hooks/bridge.ts`) is the `codex-cu` bridge from the two-mods kit by Prompt Advisers, MIT License; see `LICENSE-codex-cu-bridge`.
