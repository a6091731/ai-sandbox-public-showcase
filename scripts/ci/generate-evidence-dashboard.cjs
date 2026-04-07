#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const REPO_SLUGS = [
  "a6091731/ai-sandbox-public-showcase",
  "eGroupAI/ai-sandbox-sdk-typescript",
  "eGroupAI/ai-sandbox-sdk-python",
  "eGroupAI/ai-sandbox-sdk-java",
  "eGroupAI/ai-sandbox-sdk-go",
  "eGroupAI/ai-sandbox-sdk-csharp",
  "eGroupAI/ai-sandbox-sdk-php",
  "eGroupAI/ai-sandbox-sdk-ruby",
];

const GOVERNANCE_FILES = [
  "SECURITY.md",
  "CONTRIBUTING.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
];

const API_ROOT = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const BASE_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ai-sandbox-evidence-dashboard",
};

if (TOKEN) {
  BASE_HEADERS.Authorization = `Bearer ${TOKEN}`;
}

function daysAgo(isoString) {
  if (!isoString) {
    return null;
  }
  const diffMs = Date.now() - new Date(isoString).getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function compactDate(isoString) {
  if (!isoString) {
    return "n/a";
  }
  return isoString.slice(0, 10);
}

function pushBadge(days) {
  if (days === null) {
    return "unknown";
  }
  if (days <= 7) {
    return "![fresh](https://img.shields.io/badge/push-fresh-3fb950?style=flat-square)";
  }
  if (days <= 30) {
    return "![stale](https://img.shields.io/badge/push-warm-58a6ff?style=flat-square)";
  }
  return "![aging](https://img.shields.io/badge/push-aging-db6d28?style=flat-square)";
}

function workflowBadge(status) {
  if (!status || status === "n/a") {
    return "![n/a](https://img.shields.io/badge/workflow-n/a-8b949e?style=flat-square)";
  }
  if (status === "success") {
    return "![success](https://img.shields.io/badge/workflow-success-3fb950?style=flat-square)";
  }
  if (status === "in_progress" || status === "queued") {
    return "![running](https://img.shields.io/badge/workflow-running-58a6ff?style=flat-square)";
  }
  return "![attention](https://img.shields.io/badge/workflow-attention-db6d28?style=flat-square)";
}

function releaseBadge(days) {
  if (days === null) {
    return "![none](https://img.shields.io/badge/release-none-8b949e?style=flat-square)";
  }
  if (days <= 30) {
    return "![fresh](https://img.shields.io/badge/release-fresh-3fb950?style=flat-square)";
  }
  if (days <= 90) {
    return "![active](https://img.shields.io/badge/release-active-58a6ff?style=flat-square)";
  }
  return "![old](https://img.shields.io/badge/release-aging-db6d28?style=flat-square)";
}

function governanceBar(score) {
  const filled = Math.round(score / 10);
  const empty = Math.max(0, 10 - filled);
  return `[${"#".repeat(filled)}${"-".repeat(empty)}] ${score}%`;
}

async function fetchJson(apiPath, { optional = false } = {}) {
  const response = await fetch(`${API_ROOT}${apiPath}`, {
    headers: BASE_HEADERS,
  });

  if (!response.ok) {
    if (optional && (response.status === 403 || response.status === 404)) {
      return null;
    }

    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${apiPath}: ${body.slice(0, 240)}`,
    );
  }

  return response.json();
}

async function fileExists(slug, filePath) {
  const data = await fetchJson(`/repos/${slug}/contents/${filePath}`, {
    optional: true,
  });
  return Boolean(data);
}

async function collectRepoSignals(slug) {
  const repo = await fetchJson(`/repos/${slug}`);
  const runs = await fetchJson(`/repos/${slug}/actions/runs?per_page=10`, {
    optional: true,
  });
  const releases = await fetchJson(`/repos/${slug}/releases?per_page=1`, {
    optional: true,
  });

  const governanceChecks = await Promise.all(
    GOVERNANCE_FILES.map((filePath) => fileExists(slug, filePath)),
  );

  const governanceCount = governanceChecks.filter(Boolean).length;
  const governanceScore = Math.round(
    (governanceCount / GOVERNANCE_FILES.length) * 100,
  );

  const workflowRuns = runs?.workflow_runs || [];
  const latestRun = workflowRuns[0] || null;
  const latestCompletedRun = workflowRuns.find(
    (run) => run.status === "completed",
  ) || null;
  const latestRelease = Array.isArray(releases) ? releases[0] || null : null;

  const pushAgeDays = daysAgo(repo.pushed_at);
  const releaseAgeDays = daysAgo(latestRelease?.published_at || null);

  return {
    slug,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at,
    pushAgeDays,
    latestRun: {
      status: latestRun?.status || "n/a",
      conclusion: latestRun?.conclusion || "n/a",
      createdAt: latestRun?.created_at || null,
      htmlUrl: latestRun?.html_url || `https://github.com/${slug}/actions`,
      name: latestRun?.name || "latest run",
      stableConclusion: latestCompletedRun?.conclusion || latestRun?.conclusion || "n/a",
      stableHtmlUrl:
        latestCompletedRun?.html_url || latestRun?.html_url || `https://github.com/${slug}/actions`,
    },
    latestRelease: {
      tag: latestRelease?.tag_name || null,
      publishedAt: latestRelease?.published_at || null,
      ageDays: releaseAgeDays,
      htmlUrl: latestRelease?.html_url || `https://github.com/${slug}/releases`,
    },
    governanceCount,
    governanceScore,
  };
}

function buildMarkdown(dataset) {
  const timestamp = new Date().toISOString();
  const repos = dataset.repos;

  const totalRepos = repos.length;
  const active30d = repos.filter((repo) => repo.pushAgeDays !== null && repo.pushAgeDays <= 30).length;
  const successfulWorkflow = repos.filter(
    (repo) => repo.latestRun.stableConclusion === "success",
  ).length;
  const recentRelease90d = repos.filter(
    (repo) => repo.latestRelease.ageDays !== null && repo.latestRelease.ageDays <= 90,
  ).length;
  const avgGovernance = Math.round(
    repos.reduce((sum, repo) => sum + repo.governanceScore, 0) / totalRepos,
  );

  const lines = [];
  lines.push("# Evidence Dashboard");
  lines.push("");
  lines.push(
    "> Auto-generated by `.github/workflows/evidence-dashboard.yml`.",
  );
  lines.push(`> Last updated: \`${timestamp}\``);
  lines.push("");
  lines.push("<div align=\"center\">");
  lines.push("");
  lines.push(
    `![repos](https://img.shields.io/badge/repos-${totalRepos}-58a6ff?style=for-the-badge)`,
  );
  lines.push(
    `![active_30d](https://img.shields.io/badge/active_30d-${active30d}%2F${totalRepos}-3fb950?style=for-the-badge)`,
  );
  lines.push(
    `![workflow_green](https://img.shields.io/badge/workflow_green-${successfulWorkflow}%2F${totalRepos}-a371f7?style=for-the-badge)`,
  );
  lines.push(
    `![release_90d](https://img.shields.io/badge/release_90d-${recentRelease90d}%2F${totalRepos}-58a6ff?style=for-the-badge)`,
  );
  lines.push(
    `![governance_avg](https://img.shields.io/badge/governance_avg-${avgGovernance}%25-3fb950?style=for-the-badge)`,
  );
  lines.push("");
  lines.push("</div>");
  lines.push("");
  lines.push("## KPI Cards");
  lines.push("");
  lines.push("| KPI | Value | Target | Status |");
  lines.push("|:---|---:|---:|:---|");
  lines.push(
    `| Active repositories (30d) | ${active30d}/${totalRepos} | >= ${Math.max(1, totalRepos - 1)} | ${
      active30d >= totalRepos - 1
        ? "![ok](https://img.shields.io/badge/status-on_track-3fb950?style=flat-square)"
        : "![watch](https://img.shields.io/badge/status-watch-db6d28?style=flat-square)"
    } |`,
  );
  lines.push(
    `| Successful latest workflows | ${successfulWorkflow}/${totalRepos} | >= ${Math.max(1, totalRepos - 2)} | ${
      successfulWorkflow >= totalRepos - 2
        ? "![ok](https://img.shields.io/badge/status-on_track-3fb950?style=flat-square)"
        : "![watch](https://img.shields.io/badge/status-watch-db6d28?style=flat-square)"
    } |`,
  );
  lines.push(
    `| Repositories with release in 90d | ${recentRelease90d}/${totalRepos} | >= ${Math.max(1, totalRepos - 2)} | ${
      recentRelease90d >= totalRepos - 2
        ? "![ok](https://img.shields.io/badge/status-on_track-3fb950?style=flat-square)"
        : "![watch](https://img.shields.io/badge/status-watch-db6d28?style=flat-square)"
    } |`,
  );
  lines.push(
    `| Average governance coverage | ${avgGovernance}% | >= 90% | ${
      avgGovernance >= 90
        ? "![ok](https://img.shields.io/badge/status-on_track-3fb950?style=flat-square)"
        : "![watch](https://img.shields.io/badge/status-watch-db6d28?style=flat-square)"
    } |`,
  );
  lines.push("");
  lines.push("## Repository Signal Matrix");
  lines.push("");
  lines.push(
    "| Repository | Push Freshness | Latest Workflow | Latest Release | Governance |",
  );
  lines.push("|:---|:---|:---|:---|:---|");

  for (const repo of repos) {
    const runStatus = repo.latestRun.conclusion !== "n/a"
      ? repo.latestRun.conclusion
      : repo.latestRun.status;
    const releaseText = repo.latestRelease.tag
      ? `[\`${repo.latestRelease.tag}\`](${repo.latestRelease.htmlUrl}) · ${repo.latestRelease.ageDays}d`
      : `[releases](${repo.latestRelease.htmlUrl}) · n/a`;
    const row = [
      `[\`${repo.slug}\`](https://github.com/${repo.slug})`,
      `${pushBadge(repo.pushAgeDays)} · ${repo.pushAgeDays ?? "n/a"}d`,
      `[${workflowBadge(runStatus)}](${repo.latestRun.htmlUrl}) · ${runStatus}`,
      `${releaseBadge(repo.latestRelease.ageDays)} · ${releaseText}`,
      `${governanceBar(repo.governanceScore)} (${repo.governanceCount}/${GOVERNANCE_FILES.length})`,
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }

  lines.push("");
  lines.push("## Raw Data");
  lines.push("");
  lines.push("- JSON export: [`docs/evidence-dashboard.json`](./evidence-dashboard.json)");
  lines.push("- Source script: [`scripts/ci/generate-evidence-dashboard.cjs`](../scripts/ci/generate-evidence-dashboard.cjs)");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const repos = [];
  for (const slug of REPO_SLUGS) {
    repos.push(await collectRepoSignals(slug));
  }

  const dataset = {
    generatedAt: new Date().toISOString(),
    repos,
  };

  const dashboardPath = path.join("docs", "evidence-dashboard.md");
  const jsonPath = path.join("docs", "evidence-dashboard.json");

  await fs.writeFile(dashboardPath, buildMarkdown(dataset), "utf8");
  await fs.writeFile(jsonPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");

  console.log(`Updated ${dashboardPath} and ${jsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
