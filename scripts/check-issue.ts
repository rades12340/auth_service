// Verifies that a PR references an open GitHub issue.
// Run by .github/workflows/pr-checks.yml; see README "PR rules".

const CLOSING_PATTERN =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const TEXT_PATTERN = /#(\d+)\b/g;
const BRANCH_PATTERN = /^[^/]+\/(\d+)-/;

export type GitHubIssue = {
    number: number;
    title: string;
    state: string;
    html_url: string;
    pull_request?: unknown;
};

// Every issue number the PR mentions, most likely first: "Closes #N"-style
// references, then any other #N in the title or body, then the branch name.
// A PR can mention other PRs ("stacked on #12"), so the caller tries each.
export function extractIssueNumbers(texts: string[], branch: string): number[] {
    const found = [
        ...texts.flatMap((text) =>
            [...text.matchAll(CLOSING_PATTERN)].map((m) => m[1]),
        ),
        ...texts.flatMap((text) =>
            [...text.matchAll(TEXT_PATTERN)].map((m) => m[1]),
        ),
        branch.match(BRANCH_PATTERN)?.[1],
    ];
    return [...new Set(found.filter((n) => n !== undefined).map(Number))];
}

export function evaluateIssue(issue: GitHubIssue): string | null {
    if (issue.pull_request) {
        return `#${issue.number} is a pull request, not an issue.`;
    }
    if (issue.state === "closed") {
        return `Issue #${issue.number} is closed. Reference an open issue.`;
    }
    return null;
}

function fail(message: string): never {
    console.error(`::error::${message}`);
    process.exit(1);
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) fail(`Missing environment variable ${name}.`);
    return value;
}

async function main(): Promise<void> {
    const repo = requireEnv("GITHUB_REPOSITORY");
    const token = requireEnv("GITHUB_TOKEN");
    const texts = [process.env.PR_TITLE ?? "", process.env.PR_BODY ?? ""];

    const numbers = extractIssueNumbers(texts, process.env.HEAD_REF ?? "");
    if (numbers.length === 0) {
        fail(
            'No issue reference found. Add "Closes #123" to the PR description, ' +
                '"#123" to the title, or use a branch like feat/123-short-desc.',
        );
    }

    const rejected: string[] = [];
    let issue: GitHubIssue | null = null;
    for (const number of numbers) {
        const res = await fetch(
            `https://api.github.com/repos/${repo}/issues/${number}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                },
            },
        );
        if (res.status === 404) {
            rejected.push(`Issue #${number} does not exist.`);
            continue;
        }
        if (!res.ok)
            fail(`GitHub returned ${res.status} for issue #${number}.`);
        const candidate = (await res.json()) as GitHubIssue;
        const problem = evaluateIssue(candidate);
        if (!problem) {
            issue = candidate;
            break;
        }
        rejected.push(problem);
    }
    if (!issue) {
        fail(`No referenced open issue. ${rejected.join(" ")}`);
    }

    const line = `**Issue:** [#${issue.number}](${issue.html_url}): ${issue.title}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
        await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    }
}

if (import.meta.main) {
    await main();
}
