// Verifies that a PR references an open GitHub issue.
// Run by .github/workflows/pr-checks.yml; see README "PR rules".

const TEXT_PATTERN = /#(\d+)\b/;
const BRANCH_PATTERN = /^[^/]+\/(\d+)-/;

export type GitHubIssue = {
    number: number;
    title: string;
    state: string;
    html_url: string;
    pull_request?: unknown;
};

export function extractIssueNumber(
    texts: string[],
    branch: string,
): number | null {
    for (const text of texts) {
        const match = text.match(TEXT_PATTERN);
        if (match?.[1]) return Number(match[1]);
    }
    const match = branch.match(BRANCH_PATTERN);
    return match?.[1] ? Number(match[1]) : null;
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

    const number = extractIssueNumber(texts, process.env.HEAD_REF ?? "");
    if (!number) {
        fail(
            'No issue reference found. Add "Closes #123" to the PR description, ' +
                '"#123" to the title, or use a branch like feat/123-short-desc.',
        );
    }

    const res = await fetch(
        `https://api.github.com/repos/${repo}/issues/${number}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
            },
        },
    );
    if (res.status === 404) fail(`Issue #${number} does not exist.`);
    if (!res.ok) fail(`GitHub returned ${res.status} for issue #${number}.`);
    const issue = (await res.json()) as GitHubIssue;

    const problem = evaluateIssue(issue);
    if (problem) fail(problem);

    const line = `**Issue:** [#${issue.number}](${issue.html_url}): ${issue.title}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
        await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    }
}

if (import.meta.main) {
    await main();
}
