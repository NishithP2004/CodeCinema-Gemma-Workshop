const path = require("path");
const { spawn } = require("child_process");
const { clipText, resolveUserPath } = require("./utils");

function runGit(repoPath, args, options = {}) {
  const root = resolveUserPath(repoPath);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > (options.maxOutput || 2_000_000)) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(clipText(stderr || stdout || `git exited with ${code}`, 500)));
    });
  });
}

async function getGitInfo(repoPath) {
  try {
    const root = (await runGit(repoPath, ["rev-parse", "--show-toplevel"])).trim();
    const branch = (await runGit(repoPath, ["branch", "--show-current"])).trim();
    return {
      isGitRepo: true,
      root,
      branch: branch || "detached"
    };
  } catch (error) {
    return {
      isGitRepo: false,
      error: clipText(error.message, 180)
    };
  }
}

async function listCommits(repoPath, limit = 40) {
  const info = await getGitInfo(repoPath);
  if (!info.isGitRepo) return { ...info, commits: [] };

  const safeLimit = String(Math.max(1, Math.min(Number(limit) || 40, 100)));
  const format = "%H%x09%h%x09%ad%x09%an%x09%s";
  const output = await runGit(repoPath, ["log", `--max-count=${safeLimit}`, "--date=short", `--pretty=format:${format}`]);
  const commits = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, date, author, ...subjectParts] = line.split("\t");
      return {
        sha,
        shortSha,
        date,
        author,
        subject: subjectParts.join("\t")
      };
    });

  return { ...info, commits };
}

async function getCommitDiff(repoPath, commitSha) {
  if (!/^[a-f0-9]{7,40}$/i.test(String(commitSha || ""))) {
    throw new Error("A valid commit SHA is required.");
  }

  const info = await getGitInfo(repoPath);
  if (!info.isGitRepo) throw new Error("The selected path is not a Git repository.");

  const metadata = await runGit(repoPath, [
    "show",
    "--no-patch",
    "--date=iso-strict",
    "--format=%H%n%h%n%ad%n%an%n%ae%n%B",
    commitSha
  ]);
  const [sha, shortSha, date, author, email, ...messageLines] = metadata.split(/\r?\n/);
  const message = messageLines.join("\n").trim();
  const stat = await runGit(repoPath, ["show", "--stat", "--find-renames", "--format=", commitSha], { maxOutput: 200_000 });
  const nameStatus = await runGit(repoPath, ["show", "--name-status", "--find-renames", "--format=", commitSha], { maxOutput: 200_000 });
  const patch = await runGit(repoPath, ["show", "--find-renames", "--format=", "--unified=80", commitSha], { maxOutput: 1_200_000 });

  const files = nameStatus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/);
      const status = parts[0];
      const file = parts[parts.length - 1] || "";
      return { status, file };
    });

  return {
    ...info,
    commit: {
      sha: sha.trim(),
      shortSha: shortSha.trim(),
      date: date.trim(),
      author: author.trim(),
      email: email.trim(),
      message
    },
    stat: stat.trim(),
    files,
    patch: patch.trim()
  };
}

function chunksFromCommitDiff(commitDiff) {
  const sections = commitDiff.patch.split(/^diff --git /gm).filter(Boolean);
  const chunks = [];

  for (const section of sections) {
    const text = `diff --git ${section}`.trim();
    const match = text.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    const file = match ? match[2] : commitDiff.files[chunks.length]?.file || `commit-${chunks.length + 1}.diff`;
    const lines = text.split(/\r?\n/);
    chunks.push({
      id: `${file}:diff`,
      file,
      language: "diff",
      startLine: 1,
      endLine: lines.length,
      text,
      preview: clipText(text.replace(/\s+/g, " "), 360),
      score: 100 - chunks.length
    });
  }

  if (!chunks.length && commitDiff.stat) {
    chunks.push({
      id: `${commitDiff.commit.shortSha}:summary`,
      file: `${commitDiff.commit.shortSha}-summary.diff`,
      language: "diff",
      startLine: 1,
      endLine: commitDiff.stat.split(/\r?\n/).length,
      text: commitDiff.stat,
      preview: clipText(commitDiff.stat.replace(/\s+/g, " "), 360),
      score: 100
    });
  }

  return chunks.slice(0, 10);
}

module.exports = {
  chunksFromCommitDiff,
  getCommitDiff,
  getGitInfo,
  listCommits,
  runGit
};
