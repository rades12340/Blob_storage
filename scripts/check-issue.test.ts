import { describe, expect, test } from "bun:test";
import {
    evaluateIssue,
    extractIssueNumber,
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

describe("extractIssueNumber", () => {
    test("finds a number in the PR title", () => {
        expect(extractIssueNumber(["#12: Add JWT auth", ""], "feat/x")).toBe(
            12,
        );
    });

    test("finds Closes #N in the PR body", () => {
        expect(
            extractIssueNumber(["Add JWT auth", "Some text\n\nCloses #34"], ""),
        ).toBe(34);
    });

    test("falls back to the branch name", () => {
        expect(extractIssueNumber(["Add JWT auth", ""], "feat/12-jwt")).toBe(
            12,
        );
    });

    test("returns null when there is no reference", () => {
        expect(
            extractIssueNumber(["Add JWT auth", ""], "feat/jwt-auth"),
        ).toBeNull();
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
