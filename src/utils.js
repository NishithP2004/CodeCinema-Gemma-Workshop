const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

function loadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveUserPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("A repository path is required.");
  }

  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("A repository path is required.");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function isProbablyBinary(buffer) {
  if (!buffer || !buffer.length) return false;
  const sampleSize = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleSize; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tokenize(value) {
  return Array.from(
    new Set(
      String(value || "")
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/g)
        .map((term) => term.trim())
        .filter((term) => term.length > 1)
    )
  );
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

module.exports = {
  clipText,
  ensureDir,
  escapeHtml,
  escapeXml,
  isProbablyBinary,
  loadEnv,
  normalizeWhitespace,
  resolveUserPath,
  tokenize,
  toPosixPath
};
