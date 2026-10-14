---
name: ship-pr
description: Ship work from auth_service as a pull request that passes the repo's checks — find or create the GitHub issue, pick the type label, branch, commit, push, open the PR with "Closes #N", and watch CI until it's green. Use this whenever the user asks to push, open or create a PR, "ship this", "make a PR for this", or to fix a PR that's failing the `labels`, `issue` or `branch-name` checks — even if they don't mention issues or labels.
---

# Ship a PR

This repo is `rades12340/auth_service`, and `main` is protected: nothing reaches it except through a PR whose four required checks pass. `.github/workflows/pr-checks.yml` runs two of them:

- **labels**: the PR needs at least one of `feature`, `enhancement`, `bug` or `documentation`. Any of `wontfix`, `invalid` or `duplicate` fails it.
- **issue**: the PR must reference an **open issue**, not a PR. `scripts/check-issue.ts` looks for `#N` in the PR title or description (so `Closes #N` counts), then for a branch named like `feat/N-short-desc`.

The other two:

- **branch-name** (`.github/workflows/branch-name.yml`): the branch must match `^(feat|fix|docs|chore)/[0-9]+-[a-z0-9][a-z0-9-]*$`, e.g. `feat/12-refresh-rotation`. It runs on every branch push and on the PR. The Husky pre-push hook checks the same pattern locally, so a badly named branch can't even be pushed.
- **Lint, typecheck, test** (`ci.yml`): runs on every push to any branch and on every PR.

The steps below make all four pass on the first try, so the user doesn't have to come back and fix the PR.

## Steps

### 1. Inspect the state

```bash
git status --short && git branch --show-current
git fetch -q && git log --oneline origin/main..HEAD && git diff --stat origin/main...HEAD
gh pr view --json number,url,state,labels 2>/dev/null   # does this branch already have a PR?
```

Find out whether there's uncommitted work, whether you're on `main`, and whether a PR already exists. If one exists, go to "Fixing an existing PR" below; don't open a second PR.

### 2. Find or create the issue

The issue is the "why" of the PR. If the user named one, use it. Otherwise search first:

```bash
gh issue list --state open --search "<keywords from the change>"
```

Create an issue only if nothing fits. Use a short title that describes the task, a 1–2 sentence body saying what should be true when it's done, and the same label the PR will get. Creating an issue publishes to GitHub. If the user only asked to "push" or "open a PR", that request covers it. If they asked for something narrower, confirm first.

### 3. Pick the label

Choose it from what the diff actually does, not from the branch name:

| Change | Label |
|---|---|
| New capability | `feature` |
| Improves existing behaviour, refactor, tooling | `enhancement` |
| Fixes broken behaviour | `bug` |
| Only README or docs | `documentation` |

### 4. Branch, if you're on `main`

```bash
git switch main && git pull --ff-only && git switch -c <type>/<N>-short-slug
```

`<type>` is `feat`, `fix`, `docs` or `chore` (tooling and CI), and the slug is lowercase letters, digits and hyphens. The `branch-name` check and the pre-push hook enforce this. The issue number in the name also satisfies the issue check a second way, which helps if someone later edits the PR description.

If you're already on a badly named branch with commits, rename it before pushing: `git branch -m <type>/<N>-short-slug`.

If the work is uncommitted on `main`, `git switch -c` carries it over, so skip the pull in that case.

### 5. Commit

- Subject line: imperative and under ~70 characters, describing what changed for the user.
- Body: a few lines on why.
- A `Closes #N` line.
- The commit attribution line from the system reminder, if there is one.

Stage specific paths rather than `git add -A`, so stray files such as `uploads/` or `.env` don't get committed.

The husky hooks run on commit (lint-staged with Biome) and on push (typecheck and `bun test`). Never bypass them with `--no-verify`: protection on `main` would block the PR anyway. They run the same checks as CI, so a hook failure means CI would fail too. Fix the cause and create a new commit.

### 6. Push and open the PR

```bash
git push -u origin HEAD
```

Write the PR description to a file in your scratchpad (or another temp dir) with the Write tool, then pass it with `--body-file`:

```markdown
## Summary
- <what changed and why, 2–4 bullets>

Closes #N

## Testing
- <commands actually run and their results>

<PR attribution line from the system reminder, if any>
```

```bash
gh pr create --base main --label <label> --title "<subject>" --body-file <path-to-body.md>
```

Don't inline the description with `--body "$(cat <<'EOF' … EOF)"`. macOS ships bash 3.2, which misparses a heredoc inside `$(…)` when the text contains parentheses or backticks, and PR descriptions usually do. The command then fails with "bad substitution". A file avoids shell quoting entirely.

Only list tests in Testing that you actually ran.

If the push fails with a GitHub server error such as `Internal Server Error`, retry it once. These are usually temporary and don't mean anything is wrong with the branch.

### 7. Watch the checks

```bash
gh pr checks <number> --watch --interval 10
```

Checks take a few seconds to appear. If it says "no checks reported", wait briefly and retry.

If a check fails, read the log with `gh run view <run-id> --log-failed`, fix the cause, push again and keep watching. Report the PR URL and each check's result, and say plainly if anything is still failing.

## Fixing an existing PR

When a PR fails `labels`, `issue` or `branch-name`, such as an older PR opened before these checks existed, fix it in place:

```bash
gh pr edit <n> --add-label <label>
gh pr view <n> --json body -q .body > <tmp>/body.md   # then append "Closes #N" to the file
gh pr edit <n> --body-file <tmp>/body.md
```

A failing `branch-name` can't be fixed in place, because a PR's head branch can't be renamed on GitHub without closing it. Push the work to a correctly named branch and open a new PR, then close the old one.

Editing the label or description re-runs `pr-checks` automatically, because the workflow listens for `labeled` and `edited` events. If the PR's branch was created before `pr-checks.yml` reached `main`, the checks won't run until it's updated from `main`: use `gh pr update-branch <n>` or merge `main` into the branch.

## When `gh` isn't available

If `gh` is missing or not logged in (`gh auth status`), push with git. Then give the user:
- the compare URL `https://github.com/rades12340/auth_service/compare/main...<branch>?expand=1`
- the title, label and body to paste

Suggest `brew install gh && gh auth login` so this works next time.
