---
name: release-plugin
description: Ship a changed plugin in spider-antigravity-mods end-to-end: verify build/tests/manifest, commit, open and squash-merge the GitHub PR, fast-forward the main checkout, and reinstall the updated plugin with agy. Use when the user asks to finish development, open and merge the PR, sync main, or update the installed plugin.
---

# Release Plugin

Ship a plugin change in `spider-antigravity-mods` from a feature branch or worktree through PR merge, local `main` sync, and local Antigravity plugin update. Follows the repo rules in `AGENTS.md` and PR conventions in the `github` skill without repeating them.

## Steps

1. **Verify plugin readiness** for each modified `plugins/<name>/`:
   - Confirm `version` matches across `plugins/<name>/plugin.json`, `README.md`, `plugins/<name>/CHANGELOG.md`, and any hardcoded version constants (`SERVER_VERSION`, MCP App `appInfo.version`).
   - If `plugins/<name>/package.json` defines `build:ui`, run `pnpm --filter <name> build:ui` and ensure the updated bundle (`ui/dist/`) is included.
   - Run `pnpm --filter <name> test && pnpm --filter <name> typecheck && agy plugin validate --strict plugins/<name>`.
   - Done when every check exits `0` and `git status` shows only intentional plugin changes.

2. **Commit, push, and open PR**:
   - Stage changes and commit with a Conventional Commit message (`type(<name>): summary (vX.Y.Z)`).
   - Push the branch (`git push -u origin <branch>`) and open a ready PR via `gh pr create --assignee @me`.
   - Done when `gh pr create` returns the PR URL.

3. **Squash-merge PR (handling parallel `README.md` conflicts)**:
   - Run `gh pr merge <number> --squash --delete-branch`.
   - If GitHub reports a conflict or stale base branch, run `git fetch origin main && git merge origin/main`, resolve conflicts cleanly (typically the plugin version table in root `README.md`), commit and push, then re-run `gh pr merge <number> --squash --delete-branch`.
   - Done when the PR is merged into `main` and the remote branch is deleted.

4. **Sync the `main` checkout**:
   - Locate the `main` worktree via `git worktree list` (it may differ from the current worktree).
   - Run `git -C <main-worktree-path> pull --ff-only origin main`.
   - Done when `main` fast-forwards to the merged commit SHA.

5. **Update the installed plugin in Antigravity**:
   - Check `~/.gemini/config/plugins/<name>`: if it is a symlink to the local repo, skip reinstall (already live after step 4).
   - Otherwise, update in place with `agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/<name>` (there is no `agy plugin update` subcommand).
   - Verify with `agy plugin list` that `<name>` shows the new `version` and `enabled` status.
   - Done when the installed version matches `plugins/<name>/plugin.json`. Report the PR link, synced `main` SHA, and remind the user to reopen the UI pane or restart the MCP server if it was already running.
