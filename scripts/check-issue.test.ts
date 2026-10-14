import { describe, expect, test } from "bun:test";
import {
    evaluateIssue,
    extractIssueNumbers,
    type GitHubIssue,
} from "./check-issue";

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
        number: 12,
        title: "JWT auth",
        state: "open",
        html_url: "https://github.com/o/r/issues/12",
        ...overrides,
    };
}

describe("extractIssueNumbers", () => {
    test("finds a number in the PR title", () => {
        expect(
            extractIssueNumbers(["#12: Add JWT auth", ""], "feat/x"),
        ).toEqual([12]);
    });

    test("finds Closes #N in the PR body", () => {
        expect(
            extractIssueNumbers(
                ["Add JWT auth", "Some text\n\nCloses #34"],
                "",
            ),
        ).toEqual([34]);
    });

    test("falls back to the branch name", () => {
        expect(
            extractIssueNumbers(["Add JWT auth", ""], "feat/12-jwt"),
        ).toEqual([12]);
    });

    test("returns nothing when there is no reference", () => {
        expect(
            extractIssueNumbers(["Add JWT auth", ""], "feat/jwt-auth"),
        ).toEqual([]);
    });

    test("puts closing keywords first, even after other mentions", () => {
        expect(
            extractIssueNumbers(
                ["Docs", "Stacked on #12 (Docker).\n\nCloses #13"],
                "",
            ),
        ).toEqual([13, 12]);
        expect(
            extractIssueNumbers(["See #1", "fixes #2, Resolved #3"], ""),
        ).toEqual([2, 3, 1]);
    });

    test("orders title and body mentions before the branch, without duplicates", () => {
        expect(
            extractIssueNumbers(["#5 and #6", "Closes #6"], "feat/7-x"),
        ).toEqual([6, 5, 7]);
        expect(extractIssueNumbers(["Closes #7"], "feat/7-x")).toEqual([7]);
    });
});

describe("evaluateIssue", () => {
    test("accepts an open issue", () => {
        expect(evaluateIssue(issue())).toBeNull();
    });

    test("rejects a closed issue", () => {
        expect(evaluateIssue(issue({ state: "closed" }))).toContain("closed");
    });

    test("rejects a pull request number", () => {
        expect(evaluateIssue(issue({ pull_request: {} }))).toContain(
            "pull request",
        );
    });
});
