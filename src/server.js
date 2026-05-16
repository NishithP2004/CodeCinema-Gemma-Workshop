const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { generateCommitExplanation, generateExplanation } = require("./explainer");
const { getOllamaConfig } = require("./ollamaClient");
const { scanRepo, scanRepoBundle } = require("./repoScanner");
const { getGitInfo, listCommits } = require("./git");
const { commandExists, createMermaidChart, renderPitchDeck, renderVideoBundle } = require("./video");
const { clipText, loadEnv } = require("./utils");

loadEnv();

const PORT = Number(process.env.PORT || 5177);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const ARTIFACTS_DIR = path.join(process.cwd(), "artifacts");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".mp4", "video/mp4"],
  [".wav", "audio/wav"],
  [".aiff", "audio/aiff"],
  [".mmd", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function safeStaticPath(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(baseDir, normalized);
  if (!fullPath.startsWith(baseDir)) throw new Error("Invalid static path.");
  return fullPath;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath;

  if (url.pathname.startsWith("/artifacts/")) {
    filePath = safeStaticPath(ARTIFACTS_DIR, url.pathname.replace(/^\/artifacts\/?/, ""));
  } else {
    const publicPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    filePath = safeStaticPath(PUBLIC_DIR, publicPath);
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extension) || "application/octet-stream",
    "Content-Length": stat.size
  });
  const data = await fs.readFile(filePath);
  res.end(data);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    const { host, model } = getOllamaConfig();
    const [ffmpeg, say, piper] = await Promise.all([commandExists("ffmpeg"), commandExists("say"), commandExists("piper")]);
    sendJson(res, 200, {
      ok: true,
      model,
      ollamaHost: host,
      ttsProvider: process.env.TTS_PROVIDER || "auto",
      tools: { ffmpeg, say, piper },
      mermaidChartConfigured: Boolean(process.env.MERMAID_CHART_API_URL && process.env.MERMAID_CHART_API_KEY)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan") {
    const body = await readJson(req);
    const repo = await scanRepo(body.repoPath);
    const git = await getGitInfo(body.repoPath);
    sendJson(res, 200, {
      root: repo.root,
      git,
      stats: repo.stats,
      scannedAt: repo.scannedAt,
      files: repo.files.slice(0, 120).map((file) => ({
        path: file.relativePath,
        language: file.language,
        lineCount: file.lineCount,
        bytes: file.bytes
      }))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/git/commits") {
    const body = await readJson(req);
    const result = await listCommits(body.repoPath, body.limit || 40);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-bundle") {
    const body = await readJson(req);
    const repo = scanRepoBundle(body.repoBundle || body);
    sendJson(res, 200, {
      root: repo.root,
      source: repo.source,
      stats: repo.stats,
      scannedAt: repo.scannedAt,
      files: repo.files.slice(0, 120).map((file) => ({
        path: file.relativePath,
        language: file.language,
        lineCount: file.lineCount,
        bytes: file.bytes
      }))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/explain") {
    const body = await readJson(req);
    const explanation = await generateExplanation({
      repoPath: body.repoPath,
      repoBundle: body.repoBundle,
      query: body.query,
      mode: body.mode
    });
    sendJson(res, 200, explanation);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/explain-commit") {
    const body = await readJson(req);
    const explanation = await generateCommitExplanation({
      repoPath: body.repoPath,
      commitSha: body.commitSha,
      mode: body.mode
    });
    sendJson(res, 200, explanation);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/deck") {
    const body = await readJson(req);
    const deckPath = await renderPitchDeck(body.explanation || body);
    const id = path.basename(path.dirname(deckPath));
    sendJson(res, 200, {
      id,
      files: {
        pitchDeck: `/artifacts/${id}/${path.basename(deckPath)}`
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/render") {
    const body = await readJson(req);
    const result = await renderVideoBundle(body.explanation || body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mermaid-chart") {
    const body = await readJson(req);
    const result = await createMermaidChart(body.mermaid || body);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Unknown API route." });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: clipText(error.message || String(error), 700)
    });
  }
});

server.listen(PORT, () => {
  const { host, model } = getOllamaConfig();
  console.log(`CodeCinema running at http://localhost:${PORT}`);
  console.log(`Using Ollama model ${model} at ${host}`);
});
