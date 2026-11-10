---
name: add-commit-push-to-main
description: Stages unstaged work, commits with a message from the diff, fast-forwards from origin/main, then pushes to main. Use when the user invokes /add-commit-push-to-main, or asks to add, commit, and push to main in one step.
---

# Add, commit, and push to main

Land the current unstaged (and untracked) work on `origin/main` without overwriting remote history. Fetch and fast-forward **before** staging/committing when possible, and again **before** push. Never force-push.

## When to Use

- Use this skill when the user invokes `/add-commit-push-to-main` or asks to add, commit, and push to main in one flow.
- This skill is helpful for a private repo where work is meant to land on `main` directly, not via a feature-branch PR.
- Use the ask questions tool if the branch has diverged from `origin/main`, if it is unclear what to include, or if a force-push would be required.

## Instructions

### Hard rules (do not violate)

- NEVER update git config.
- NEVER `git push --force`, `--force-with-lease`, or `+ref` to `main`/`master`.
- NEVER `git reset --hard` to remote, `git checkout --theirs` of the whole tree, or `git clean -fd` unless the user explicitly asked to discard work.
- NEVER skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- Do not use interactive git (`-i`).
- Do not use the TodoWrite or Task tools while running this skill.
- Do not commit secrets (`.env`, credentials, tokens, private keys). Warn and unstage them.
- Do not create an empty commit. If there is nothing to commit after pull, say so and stop (push only if `main` is already ahead of origin and fast-forward).

### 1. Inspect, then sync with remote **first**

Run in parallel (Shell):

- `git status -sb`
- `git diff` and `git diff --cached`
- `git fetch origin`
- `git rev-parse --abbrev-ref HEAD`
- `git log --oneline -5`

Then **update local `main` from the remote before changing history or pushing**:

1. If there are uncommitted changes, stash them so pull cannot be blocked and cannot clobber the working tree:

```bash
git stash push -u -m "add-commit-push-to-main: stash before pull"
```

Only stash if `git status` is not clean. Include untracked (`-u`) so a later checkout of `main` cannot overwrite untracked files.

2. If HEAD is not `main`, check out `main`. If checkout fails, stop and tell the user. Do not force checkout.

3. Fast-forward local `main` only:

```bash
git pull --ff-only origin main
```

If `--ff-only` fails, **stop**. Local `main` and `origin/main` have diverged. Do not merge casually, rebase, or force-push. Use the ask questions tool: merge vs rebase vs abort.

4. Restore the stash if you created one:

```bash
git stash pop
```

If `stash pop` conflicts, **stop**. Resolve with the user. Do not `-X theirs` or drop the stash.

### 2. Stage

- `git add` the intended unstaged and untracked files (the work that belongs in this commit).
- Do not add files that look like secrets. Leave them unstaged and warn.
- `git status` after add. If nothing is staged, stop.

### 3. Commit

- Draft a 1–2 sentence message from the staged diff (`git diff --cached`). Focus on **why**, in the repo’s existing commit style (`git log -5`).
- Commit with HEREDOC only:

```bash
git commit -m "$(cat <<'EOF'
Commit message here.

EOF
)"
```

### 4. Sync again, then push (still no force)

Remote may have moved during the commit:

```bash
git fetch origin
git pull --ff-only origin main
git push origin main
```

- If the second `--ff-only` fails, **stop**. Do not force-push. Ask the user.
- If `git push` is rejected (non-fast-forward), **stop**. Fetch, show `git status -sb` and `git log --oneline HEAD...origin/main`, and ask. Do not retry with `--force`.
- After a successful push, run `git status -sb` and report the new `origin/main` SHA and commit subject.
