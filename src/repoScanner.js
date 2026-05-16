const fs = require("fs/promises");
const path = require("path");
const {
  clipText,
  isProbablyBinary,
  normalizeWhitespace,
  resolveUserPath,
  tokenize,
  toPosixPath
} = require("./utils");

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".turbo",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "artifacts"
]);

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".dockerfile",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const SPECIAL_TEXT_FILES = new Set([
  "dockerfile",
  "makefile",
  "readme",
  "license",
  "gemfile",
  "rakefile",
  "procfile"
]);

const LANGUAGE_BY_EXTENSION = new Map([
  [".astro", "astro"],
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".go", "go"],
  [".graphql", "graphql"],
  [".h", "c"],
  [".hpp", "cpp"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".json", "json"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".lua", "lua"],
  [".md", "markdown"],
  [".mdx", "mdx"],
  [".mjs", "javascript"],
  [".php", "php"],
  [".proto", "protobuf"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".scss", "scss"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svelte", "svelte"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".vue", "vue"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"]
]);

const SEARCH_STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "code",
  "does",
  "explain",
  "file",
  "files",
  "for",
  "how",
  "implementation",
  "in",
  "of",
  "repo",
  "repository",
  "the",
  "to",
  "use",
  "uses",
  "using",
  "work",
  "works"
]);

function shouldReadFile(fileName) {
  const lower = fileName.toLowerCase();
  const extension = path.extname(lower);
  return TEXT_EXTENSIONS.has(extension) || SPECIAL_TEXT_FILES.has(lower);
}

function languageFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION.get(path.extname(lower)) || "text";
}

function buildChunks(file, options = {}) {
  const maxLines = options.maxChunkLines || 120;
  const overlap = options.chunkOverlapLines || 18;
  const lines = file.content.split(/\r?\n/);
  const chunks = [];
  let startIndex = 0;

  while (startIndex < lines.length) {
    const endIndex = Math.min(lines.length, startIndex + maxLines);
    const chunkLines = lines.slice(startIndex, endIndex);
    const text = chunkLines.join("\n").trim();
    if (text) {
      chunks.push({
        id: `${file.relativePath}:${startIndex + 1}-${endIndex}`,
        file: file.relativePath,
        language: file.language,
        startLine: startIndex + 1,
        endLine: endIndex,
        text,
        preview: clipText(normalizeWhitespace(text), 360)
      });
    }
    if (endIndex >= lines.length) break;
    startIndex = Math.max(endIndex - overlap, startIndex + 1);
  }

  return chunks;
}

function hasIgnoredSegment(relativePath, ignoredDirs) {
  return relativePath
    .split("/")
    .map((segment) => segment.toLowerCase())
    .some((segment) => ignoredDirs.has(segment));
}

function normalizeBundlePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/(^|\/)\.\.(?=\/|$)/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

async function scanRepo(repoPath, options = {}) {
  const root = resolveUserPath(repoPath);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${root}`);
  }

  const maxFileBytes = options.maxFileBytes || 220_000;
  const maxFiles = options.maxFiles || 800;
  const maxTotalBytes = options.maxTotalBytes || 18_000_000;
  const ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoredDirs || [])]);
  const files = [];
  let skipped = 0;
  let skippedLarge = 0;
  let totalBytes = 0;

  async function walk(currentDir, relativeDir = "") {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) return;

    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) return;

      const entryPath = path.join(currentDir, entry.name);
      const relativePath = toPosixPath(path.join(relativeDir, entry.name));

      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name.toLowerCase())) continue;
        await walk(entryPath, relativePath);
        continue;
      }

      if (!entry.isFile() || !shouldReadFile(entry.name)) {
        skipped += 1;
        continue;
      }

      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat || stat.size > maxFileBytes) {
        skippedLarge += 1;
        continue;
      }

      const buffer = await fs.readFile(entryPath).catch(() => null);
      if (!buffer || isProbablyBinary(buffer)) {
        skipped += 1;
        continue;
      }

      const content = buffer.toString("utf8");
      totalBytes += buffer.length;
      const lines = content.split(/\r?\n/);
      files.push({
        absolutePath: entryPath,
        relativePath,
        language: languageFor(entry.name),
        bytes: buffer.length,
        lineCount: lines.length,
        content
      });
    }
  }

  await walk(root);

  const chunks = files.flatMap((file) => buildChunks(file, options));
  const languages = files.reduce((acc, file) => {
    acc[file.language] = (acc[file.language] || 0) + 1;
    return acc;
  }, {});

  return {
    root,
    files,
    chunks,
    stats: {
      fileCount: files.length,
      chunkCount: chunks.length,
      totalBytes,
      skipped,
      skippedLarge,
      languages
    },
    scannedAt: new Date().toISOString()
  };
}

function scanRepoBundle(bundle, options = {}) {
  const rootName = normalizeWhitespace(bundle?.rootName || "Selected folder") || "Selected folder";
  const inputFiles = Array.isArray(bundle?.files) ? bundle.files : [];
  if (!inputFiles.length) {
    throw new Error("Choose a folder first, or enter a local repo path.");
  }

  const maxFileBytes = options.maxFileBytes || 220_000;
  const maxFiles = options.maxFiles || 800;
  const maxTotalBytes = options.maxTotalBytes || 18_000_000;
  const ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoredDirs || [])]);
  const files = [];
  let skipped = 0;
  let skippedLarge = 0;
  let totalBytes = 0;

  for (const inputFile of inputFiles) {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;

    const relativePath = normalizeBundlePath(inputFile.relativePath || inputFile.path || inputFile.name);
    const fileName = path.basename(relativePath);
    if (!relativePath || hasIgnoredSegment(relativePath, ignoredDirs) || !shouldReadFile(fileName)) {
      skipped += 1;
      continue;
    }

    const content = String(inputFile.content || "");
    const bytes = Buffer.byteLength(content, "utf8");
    if (!content || bytes > maxFileBytes || totalBytes + bytes > maxTotalBytes) {
      skippedLarge += bytes > maxFileBytes ? 1 : 0;
      skipped += bytes > maxFileBytes ? 0 : 1;
      continue;
    }

    totalBytes += bytes;
    const lines = content.split(/\r?\n/);
    files.push({
      absolutePath: null,
      relativePath,
      language: languageFor(fileName),
      bytes,
      lineCount: lines.length,
      content
    });
  }

  const chunks = files.flatMap((file) => buildChunks(file, options));
  const languages = files.reduce((acc, file) => {
    acc[file.language] = (acc[file.language] || 0) + 1;
    return acc;
  }, {});

  return {
    root: rootName,
    source: "browser-folder",
    files,
    chunks,
    stats: {
      fileCount: files.length,
      chunkCount: chunks.length,
      totalBytes,
      skipped,
      skippedLarge,
      languages
    },
    scannedAt: new Date().toISOString()
  };
}

function retrieveChunks(query, chunks, options = {}) {
  const limit = options.limit || 12;
  const queryTerms = tokenize(query).filter((term) => !SEARCH_STOP_TERMS.has(term));
  const queryText = String(query || "").toLowerCase();

  const scored = chunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    const pathText = chunk.file.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      const textHits = Math.min(text.split(term).length - 1, 5);
      const pathHits = pathText.split(term).length - 1;
      score += textHits;
      score += pathHits * 10;
      if (pathText.includes(term)) score += 14;
      if (/auth|login|session|token|jwt|oauth/.test(term) && /auth|login|session|token|jwt|oauth/.test(text)) score += 4;
      if (/route|api|endpoint|request|http/.test(term) && /router|route|endpoint|controller|handler|request|response/.test(text)) score += 4;
      if (/database|db|schema|model|migration|sql/.test(term) && /database|schema|model|migration|select|insert|update|table/.test(text)) score += 4;
      if (/cache|redis|queue/.test(term) && /cache|redis|queue|ttl|pubsub/.test(text)) score += 4;
    }

    if (queryText && text.includes(queryText)) score += 20;
    if (/readme|docs?\//.test(pathText)) score += 2;
    if (/test|spec|mock/.test(pathText)) score -= 2;
    if (/function |def |class |export |async |route|router|handler|controller/.test(text)) score += 2;

    return { ...chunk, score };
  });

  return scored
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

module.exports = {
  scanRepo,
  scanRepoBundle,
  retrieveChunks
};
