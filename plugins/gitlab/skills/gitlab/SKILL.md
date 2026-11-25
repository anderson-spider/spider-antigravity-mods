---
name: gitlab
description: Work with GitLab merge requests, pipelines, jobs, job logs, labels, comments, and draft notes using this plugin's GitLab MCP server (`gitlab_gitlab`). Use automatically whenever the user shares a GitLab URL or asks about a merge request (MR), pipeline, CI job, job log, or GitLab label. Never for GitHub.
---

# GitLab

Use this plugin's MCP server (`gitlab_gitlab`) for all GitLab MR, comment, pipeline, job log, label, and user operations. Never use these tools for GitHub.

## Tools (`gitlab_gitlab` MCP server)

Tools may be exposed directly or lazy-loaded via `call_mcp_tool` with `ServerName: "gitlab_gitlab"`:

- `gitlab_mr`
- `gitlab_mr_comment`
- `gitlab_pipeline`
- `gitlab_job_log`
- `gitlab_label`
- `gitlab_user`
- `gitlab_mr_dashboard` (opens or focuses the interactive **GitLab MRs** MCP App in the side pane; pass optional `cwd`, `host`, `project`, `iid`, `state`, or `involvement`)

### Targeting a repository, host, and MR

- When the user provides a full MR, pipeline, or job URL, extract the host, project path, and numeric id: `https://<host>/<group>/<project>/-/merge_requests/<iid>`, `.../-/pipelines/<id>`, `.../-/jobs/<id>`.
- Inside a local clone of that project, pass `cwd` (the repository's absolute path) so the server reliably reads the host, project, and current branch from git even without MCP workspace roots. Then pass only the id (`iid`, `pipelineId`, `jobId`), or omit `iid` to target the open MR of the current branch.
- Outside a clone of that project, pass `host` (host name only, never a URL) and `project` (`group/subgroup/project` or numeric id), plus `iid` for any MR action (with `project`, there is no current-branch MR).
- When called outside a GitLab repository without `host`, the server automatically targets the sole configured host when only one host exists in `GITLAB_MCP_TOKENS`. If multiple hosts are configured, the error lists the configured hosts — ask the user which host to target instead of guessing.
- If a call is refused (missing token, unknown host, permission error, or a safety guard), show the error to the user and what it says to do; do not guess, retry with other inputs, or work around it with another tool.
- Use git and the codebase to understand what happened (failing job, MR diff, branch state); edit files only when the task requires a fix.
- Never merge, close, rebase, approve, or cancel anything unless the user explicitly asked. On someone else's MR, pass `allowOthers: true` only when the user explicitly asked to write on it.

## Reading first

Read before writing: inspect the current state a write depends on, then act on it.

- MR: `gitlab_mr` `get` (with description), `diff` (`files` to narrow it), `commits`. To check merge readiness: `status` (merge status, conflicts, blocking discussions, draft, head pipeline, approvals, `sha`, `blockers`).
- Comments: `gitlab_mr_comment` `list` (`unresolvedOnly: true` to narrow it), or `unresolved` for a compact summary of open threads.
- Labels: `gitlab_label` `list` (`search` to narrow it) before applying any. Apply only existing labels via `gitlab_mr` `update` with `addLabels`/`removeLabels`; missing labels are refused by name. Pass `createMissingLabels: true`, or call `gitlab_label` `create`, only when the user asked for a new label.
- Users: `gitlab_user` with no username (or `username: "@me"`) for the token owner, or pass `username` to look up someone else.

## Creating a merge request

- Push the branch with git first; these tools do not push.
- Follow the repository's own rules (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `CONTRIBUTING.md`, MR templates, commit-lint) and any user rules for title format, language, and description structure. Otherwise write a clear, concise title and description matching the repository's convention.
- Call `gitlab_mr` `create` with `title`, `targetBranch`, and `description` (`sourceBranch` defaults to the current branch). It opens ready and assigned to `@me` by default — do not pass `draft: true` unless the user asks for a draft.

## Comments on MRs

Match the language of the repository and conversation (or the user's rules). Post a visible comment (`gitlab_mr_comment` `comment`, `reply` with `discussionId`, `line`) only when the user explicitly asked for a visible comment; review findings go as draft notes.

## Draft notes

Draft notes are visible only to their author until published. All of them go through `gitlab_mr_comment` with `draft: true`:

- List: `drafts`.
- General summary note: `comment` with `body`.
- Diff line note: `line` with `body`, `path`, and `line` (new-side line for an added line), `oldLine` (old-side line for a removed line), or both (an unchanged line). The tool builds the diff position automatically. One call per note.
- Reply in a thread: `reply` with `discussionId`. Edit a draft: `edit` with `noteId`.
- Never `publish` draft notes unless the user explicitly asks to publish them.
- Deleting a draft note is not offered by the tools. Only when the user explicitly asks to delete or replace one, fall back to `glab api -X DELETE projects/<url-encoded path>/merge_requests/<iid>/draft_notes/<id>` (`--hostname <host>` off the remote's host); if `glab` is not installed or fails, show the error.

## Pipelines and jobs

- Status: `gitlab_pipeline` `list` (an MR's pipelines, or those of `ref`) and `jobs` (latest pipeline by default, or `pipelineId`; `failedOnly: true` for failed jobs and failed downstream pipelines).
- Check once and report the current state (`queued`, `running`, `passed`, `failed`). Use `wait` (polls every 15 seconds, `minutes` up to 30) only when the user asked to wait or the task cannot proceed without the result.
- Job log: `gitlab_job_log` with `jobId`; `mode` `errors` (default, `pattern` to match custom lines), `tail` (`lines`), or `full`. Show the relevant raw excerpts (errors, failing step, last lines) plus your diagnosis, not only a paraphrase.
- Call `run`, `retry`, `cancel`, and `play` only when the user asked. `artifacts` lists a job's artifacts and URLs; downloading them is left to the user.

## Not covered by the tools

The tools cover MRs, their comments and draft notes, pipelines, jobs, labels, and users. For anything else (issues, deleting a draft note, reading files or branches on the server, downloading artifacts), state that this plugin does not cover it and fall back to the `glab` CLI (`glab issue ...`, `glab api ...`, with `-R <full project URL>` or `--hostname <host>` off the remote's host) if installed, or to git for branch state. Never invent a tool or an action.
