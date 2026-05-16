const state = {
  health: null,
  scan: null,
  explanation: null,
  render: null,
  repoBundle: null,
  commits: [],
  deck: null
};

const $ = (selector) => document.querySelector(selector);

const CLIENT_IGNORED_DIRS = new Set([
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

const CLIENT_TEXT_EXTENSIONS = new Set([
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

const CLIENT_SPECIAL_TEXT_FILES = new Set(["dockerfile", "makefile", "readme", "license", "gemfile", "rakefile", "procfile"]);
const MAX_CLIENT_FILE_BYTES = 220_000;
const MAX_CLIENT_TOTAL_BYTES = 18_000_000;
const MAX_CLIENT_FILES = 800;

const elements = {
  form: $("#queryForm"),
  repoPath: $("#repoPath"),
  query: $("#query"),
  mode: $("#mode"),
  folderInput: $("#folderInput"),
  chooseFolderButton: $("#chooseFolderButton"),
  clearFolderButton: $("#clearFolderButton"),
  sourceBadge: $("#sourceBadge"),
  loadCommitsButton: $("#loadCommitsButton"),
  commitSelect: $("#commitSelect"),
  explainCommitButton: $("#explainCommitButton"),
  gitStatus: $("#gitStatus"),
  scanButton: $("#scanButton"),
  explainButton: $("#explainButton"),
  deckButton: $("#deckButton"),
  renderButton: $("#renderButton"),
  copyMermaidButton: $("#copyMermaidButton"),
  chartButton: $("#chartButton"),
  healthPill: $("#healthPill"),
  modelDisplay: $("#modelDisplay"),
  modelBadge: $("#modelBadge"),
  stageStatus: $("#stageStatus"),
  stageTitle: $("#stageTitle"),
  statsGrid: $("#statsGrid"),
  answerBody: $("#answerBody"),
  citations: $("#citations"),
  citationCount: $("#citationCount"),
  mermaidPreview: $("#mermaidPreview"),
  scenes: $("#scenes"),
  sceneCount: $("#sceneCount"),
  videoOutput: $("#videoOutput"),
  toast: $("#toast")
};

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function setBusy(isBusy, label = "Working") {
  elements.explainButton.disabled = isBusy;
  elements.scanButton.disabled = isBusy;
  elements.chooseFolderButton.disabled = isBusy;
  elements.clearFolderButton.disabled = isBusy || !state.repoBundle;
  elements.loadCommitsButton.disabled = isBusy || Boolean(state.repoBundle);
  elements.explainCommitButton.disabled = isBusy || !elements.commitSelect.value || Boolean(state.repoBundle);
  elements.deckButton.disabled = isBusy || !state.explanation;
  elements.renderButton.disabled = isBusy || !state.explanation;
  elements.stageStatus.textContent = isBusy ? label : "Ready";
}

function fileExtension(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

function normalizeBrowserPath(file) {
  return String(file.webkitRelativePath || file.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function splitRootPath(browserPath) {
  const parts = browserPath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return { rootName: "Selected folder", relativePath: parts[0] || browserPath };
  }
  return {
    rootName: parts[0],
    relativePath: parts.slice(1).join("/")
  };
}

function isClientReadableFile(relativePath, file) {
  const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
  if (segments.some((segment) => CLIENT_IGNORED_DIRS.has(segment))) return false;

  const fileName = segments[segments.length - 1] || "";
  return CLIENT_TEXT_EXTENSIONS.has(fileExtension(fileName)) || CLIENT_SPECIAL_TEXT_FILES.has(fileName) || file.type.startsWith("text/");
}

async function buildRepoBundle(fileList) {
  const selectedFiles = Array.from(fileList || []);
  if (!selectedFiles.length) throw new Error("No folder files were selected.");

  let rootName = "Selected folder";
  let totalBytes = 0;
  let skipped = 0;
  let skippedLarge = 0;
  const files = [];

  for (const file of selectedFiles) {
    if (files.length >= MAX_CLIENT_FILES || totalBytes >= MAX_CLIENT_TOTAL_BYTES) break;

    const browserPath = normalizeBrowserPath(file);
    const split = splitRootPath(browserPath);
    rootName = split.rootName || rootName;
    const relativePath = split.relativePath;

    if (!relativePath || !isClientReadableFile(relativePath, file)) {
      skipped += 1;
      continue;
    }

    if (file.size > MAX_CLIENT_FILE_BYTES || totalBytes + file.size > MAX_CLIENT_TOTAL_BYTES) {
      skippedLarge += 1;
      continue;
    }

    const content = await file.text();
    files.push({
      relativePath,
      content
    });
    totalBytes += file.size;
  }

  if (!files.length) throw new Error("No readable source files were found in that folder.");

  return {
    rootName,
    files,
    clientStats: {
      selectedCount: selectedFiles.length,
      includedCount: files.length,
      skipped,
      skippedLarge,
      totalBytes
    }
  };
}

function updateRepoSourceUi() {
  if (state.repoBundle) {
    const count = state.repoBundle.files.length;
    elements.sourceBadge.textContent = `Selected folder: ${state.repoBundle.rootName} (${count} files)`;
    elements.repoPath.placeholder = "Folder selected in browser";
    elements.clearFolderButton.disabled = false;
    elements.loadCommitsButton.disabled = true;
    elements.explainCommitButton.disabled = true;
    elements.gitStatus.textContent = "Git commit selection is available for typed local paths.";
    return;
  }

  elements.sourceBadge.textContent = "Using typed path";
  elements.repoPath.placeholder = "/Users/you/project";
  elements.clearFolderButton.disabled = true;
  elements.loadCommitsButton.disabled = false;
}

function repoRequestBody(extra = {}) {
  if (state.repoBundle) {
    return {
      repoBundle: state.repoBundle,
      ...extra
    };
  }

  return {
    repoPath: elements.repoPath.value.trim(),
    ...extra
  };
}

function updateStats(stats = {}, refs = 0) {
  elements.statsGrid.innerHTML = `
    <div><strong>${stats.fileCount || 0}</strong><span>files</span></div>
    <div><strong>${stats.chunkCount || 0}</strong><span>chunks</span></div>
    <div><strong>${refs}</strong><span>refs</span></div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAnswer(explanation) {
  elements.answerBody.className = "answer-text";
  elements.answerBody.textContent = explanation.answer || "No answer returned.";
  elements.modelBadge.textContent = `${explanation.model?.name || "Gemma"} / Ollama`;
}

function renderCitations(citations = []) {
  elements.citationCount.textContent = `${citations.length} ref${citations.length === 1 ? "" : "s"}`;
  if (!citations.length) {
    elements.citations.innerHTML = "";
    return;
  }

  elements.citations.innerHTML = citations
    .map(
      (citation) => `
        <div class="citation-item">
          <strong>${escapeHtml(citation.file)}:${citation.startLine}-${citation.endLine}</strong>
          <p>${escapeHtml(citation.why || "Referenced by the explanation")}</p>
          ${citation.preview ? `<div class="citation-preview">${escapeHtml(citation.preview)}</div>` : ""}
        </div>
      `
    )
    .join("");
}

async function renderMermaid(mermaid) {
  const code = mermaid?.code || "";
  if (!code) {
    elements.mermaidPreview.textContent = "No diagram yet.";
    return;
  }

  elements.mermaidPreview.innerHTML = `<pre>${escapeHtml(code)}</pre>`;

  try {
    const module = await import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs");
    module.default.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose" });
    const id = `codec-cinema-${Date.now()}`;
    const { svg } = await module.default.render(id, code);
    elements.mermaidPreview.innerHTML = svg;
  } catch (error) {
    elements.mermaidPreview.innerHTML = `<pre>${escapeHtml(code)}</pre>`;
  }
}

function renderScenes(scenes = [], timeline = []) {
  elements.sceneCount.textContent = `${scenes.length} scene${scenes.length === 1 ? "" : "s"}`;
  elements.scenes.innerHTML = scenes
    .map((scene, index) => {
      const timing = timeline[index]?.seconds ? `${timeline[index].seconds}s` : "scene";
      return `
        <div class="scene-item">
          <strong>${index + 1}. ${escapeHtml(scene.title)} / ${escapeHtml(timing)}</strong>
          ${scene.slideText ? `<p>${escapeHtml(scene.slideText)}</p>` : ""}
          <p>${escapeHtml(scene.narration)}</p>
          <p>${escapeHtml(scene.visual || "")}</p>
        </div>
      `;
    })
    .join("");
}

function renderCommitOptions(commits = []) {
  if (!commits.length) {
    elements.commitSelect.innerHTML = '<option value="">No commits loaded</option>';
    elements.commitSelect.disabled = true;
    elements.explainCommitButton.disabled = true;
    return;
  }

  elements.commitSelect.innerHTML = commits
    .map((commit) => {
      const label = `${commit.shortSha} / ${commit.date} / ${commit.subject}`;
      return `<option value="${escapeHtml(commit.sha)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  elements.commitSelect.disabled = false;
  elements.explainCommitButton.disabled = false;
}

function updateStageForExplanation(explanation) {
  elements.stageTitle.textContent = explanation.scenes?.[0]?.title || "Storyboard generated";
  elements.stageStatus.textContent = "Storyboard ready";
  updateStats(explanation.repo?.stats || {}, explanation.citations?.length || 0);
}

function renderWarnings(warnings = []) {
  if (!warnings.length) return "";
  return `<div class="warnings">${warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join("")}</div>`;
}

function renderVideoResult(result) {
  const files = result.files || {};
  const assets = Object.entries(files)
    .filter(([, href]) => href)
    .map(([label, href]) => `<div class="asset-row"><a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></div>`)
    .join("");

  elements.videoOutput.innerHTML = `
    ${files.video ? `<video src="${files.video}" controls></video>` : `<div class="video-placeholder">MP4 render was skipped. Storyboard assets are ready.</div>`}
    <div class="asset-grid">${assets}</div>
    ${renderWarnings(result.warnings || [])}
  `;
}

function appendDeckLink(result) {
  const href = result?.files?.pitchDeck;
  if (!href) return;
  const deckRow = document.createElement("div");
  deckRow.className = "asset-row";
  deckRow.innerHTML = `<a href="${href}" download>pitchDeck</a>`;
  let assetGrid = elements.videoOutput.querySelector(".asset-grid");
  if (!assetGrid) {
    assetGrid = document.createElement("div");
    assetGrid.className = "asset-grid";
    elements.videoOutput.appendChild(assetGrid);
  }
  assetGrid.prepend(deckRow);
}

function downloadHref(href) {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    state.health = health;
    elements.healthPill.textContent = `${health.model} / ${health.tools.ffmpeg ? "ffmpeg" : "no ffmpeg"}`;
    elements.healthPill.className = `health-pill ${health.tools.ffmpeg ? "ok" : "warn"}`;
    elements.modelDisplay.value = `${health.model} @ ${health.ollamaHost}`;
  } catch (error) {
    elements.healthPill.textContent = "Stack check failed";
    elements.healthPill.className = "health-pill warn";
  }
}

async function scanRepo() {
  const repoPath = elements.repoPath.value.trim();
  if (!state.repoBundle && !repoPath) {
    toast("Choose a folder or add a local repo path first.");
    return;
  }
  setBusy(true, "Scanning");
  try {
    const scan = await api(state.repoBundle ? "/api/scan-bundle" : "/api/scan", {
      method: "POST",
      body: repoRequestBody()
    });
    state.scan = scan;
    updateStats(scan.stats, state.explanation?.citations?.length || 0);
    elements.stageTitle.textContent = "Repository scanned";
    elements.stageStatus.textContent = `${scan.stats.fileCount} files indexed`;
    if (!state.repoBundle && scan.git?.isGitRepo) {
      elements.gitStatus.textContent = `Git repo detected on ${scan.git.branch}. Load commits to explain a changelog.`;
    } else if (!state.repoBundle) {
      elements.gitStatus.textContent = "No Git repository detected for this typed path.";
    }
    toast("Repo scan complete.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function generateExplainer(event) {
  event.preventDefault();
  const repoPath = elements.repoPath.value.trim();
  const query = elements.query.value.trim();
  if ((!state.repoBundle && !repoPath) || !query) {
    toast("Choose a folder or enter a repo path, then add a query.");
    return;
  }

  setBusy(true, "Asking Gemma");
  elements.stageTitle.textContent = "Gemma is building the walkthrough";
  try {
    const explanation = await api("/api/explain", {
      method: "POST",
      body: repoRequestBody({
        query,
        mode: elements.mode.value
      })
    });
    state.explanation = explanation;
    state.deck = null;
    renderAnswer(explanation);
    renderCitations(explanation.citations);
    await renderMermaid(explanation.mermaid);
    renderScenes(explanation.scenes, explanation.timeline);
    updateStageForExplanation(explanation);
    elements.renderButton.disabled = false;
    elements.deckButton.disabled = false;
    if (explanation.warnings?.length) toast(explanation.warnings[0]);
    else toast("Explainer generated.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function chooseFolder() {
  elements.folderInput.value = "";
  elements.folderInput.click();
}

async function handleFolderSelected() {
  if (!elements.folderInput.files?.length) return;

  setBusy(true, "Reading folder");
  try {
    const bundle = await buildRepoBundle(elements.folderInput.files);
    state.repoBundle = bundle;
    state.scan = null;
    state.explanation = null;
    state.render = null;
    state.deck = null;
    state.commits = [];
    renderCommitOptions([]);
    elements.renderButton.disabled = true;
    elements.deckButton.disabled = true;
    updateRepoSourceUi();
    updateStats({}, 0);
    elements.stageTitle.textContent = "Folder selected";
    elements.stageStatus.textContent = `${bundle.files.length} files ready`;
    toast(`Selected ${bundle.rootName}.`);
  } catch (error) {
    state.repoBundle = null;
    updateRepoSourceUi();
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function clearSelectedFolder() {
  state.repoBundle = null;
  elements.folderInput.value = "";
  updateRepoSourceUi();
  toast("Folder selection cleared.");
}

async function loadCommits() {
  const repoPath = elements.repoPath.value.trim();
  if (!repoPath) {
    toast("Enter a local Git repo path first.");
    return;
  }
  if (state.repoBundle) {
    toast("Commit selection needs a typed local Git path.");
    return;
  }

  setBusy(true, "Loading commits");
  try {
    const result = await api("/api/git/commits", {
      method: "POST",
      body: { repoPath, limit: 50 }
    });
    state.commits = result.commits || [];
    renderCommitOptions(state.commits);
    elements.gitStatus.textContent = result.isGitRepo
      ? `${state.commits.length} commits loaded from ${result.branch}.`
      : "No Git repository detected for this path.";
    toast(result.isGitRepo ? "Commits loaded." : "Not a Git repository.");
  } catch (error) {
    renderCommitOptions([]);
    elements.gitStatus.textContent = "Could not load commits.";
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function explainSelectedCommit() {
  const repoPath = elements.repoPath.value.trim();
  const commitSha = elements.commitSelect.value;
  if (!repoPath || !commitSha) {
    toast("Load commits and select one first.");
    return;
  }

  setBusy(true, "Explaining commit");
  elements.stageTitle.textContent = "Gemma is reading the diff";
  try {
    const explanation = await api("/api/explain-commit", {
      method: "POST",
      body: {
        repoPath,
        commitSha,
        mode: elements.mode.value
      }
    });
    state.explanation = explanation;
    state.deck = null;
    renderAnswer(explanation);
    renderCitations(explanation.citations);
    await renderMermaid(explanation.mermaid);
    renderScenes(explanation.scenes, explanation.timeline);
    updateStageForExplanation(explanation);
    elements.renderButton.disabled = false;
    elements.deckButton.disabled = false;
    toast(explanation.warnings?.[0] || "Commit changelog generated.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function renderVideo() {
  if (!state.explanation) return;
  setBusy(true, "Rendering MP4");
  elements.videoOutput.innerHTML = `<div class="video-placeholder">Rendering narration, slides, and MP4...</div>`;
  try {
    const result = await api("/api/render", {
      method: "POST",
      body: { explanation: state.explanation }
    });
    state.render = result;
    renderVideoResult(result);
    elements.stageStatus.textContent = result.files?.video ? "MP4 ready" : "Assets ready";
    toast(result.files?.video ? "Video render complete." : "Storyboard assets exported.");
  } catch (error) {
    elements.videoOutput.innerHTML = `<div class="video-placeholder">${escapeHtml(error.message)}</div>`;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function downloadPitchDeck() {
  if (!state.explanation) return;

  setBusy(true, "Exporting deck");
  try {
    const result = await api("/api/deck", {
      method: "POST",
      body: { explanation: state.explanation }
    });
    state.deck = result;
    appendDeckLink(result);
    if (result.files?.pitchDeck) downloadHref(result.files.pitchDeck);
    toast("Pitch deck ready.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function copyMermaid() {
  const code = state.explanation?.mermaid?.code;
  if (!code) {
    toast("No Mermaid diagram yet.");
    return;
  }
  await navigator.clipboard.writeText(code);
  toast("Mermaid copied.");
}

async function sendToMermaidChart() {
  const mermaid = state.explanation?.mermaid;
  if (!mermaid?.code) {
    toast("No Mermaid diagram yet.");
    return;
  }

  try {
    const result = await api("/api/mermaid-chart", {
      method: "POST",
      body: { mermaid }
    });
    if (result.url) window.open(result.url, "_blank", "noreferrer");
    toast(result.configured ? "Mermaid Chart request complete." : "Set Mermaid Chart env vars to sync diagrams.");
  } catch (error) {
    toast(error.message);
  }
}

function installRailNavigation() {
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.jump);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll(".rail-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

elements.repoPath.value = localStorage.getItem("codec-cinema-repo") || "";
elements.repoPath.addEventListener("input", () => {
  if (state.repoBundle) {
    state.repoBundle = null;
    elements.folderInput.value = "";
    updateRepoSourceUi();
  }
  state.commits = [];
  renderCommitOptions([]);
  elements.gitStatus.textContent = "Use a typed local path to load commits.";
  localStorage.setItem("codec-cinema-repo", elements.repoPath.value);
});
elements.chooseFolderButton.addEventListener("click", chooseFolder);
elements.folderInput.addEventListener("change", handleFolderSelected);
elements.clearFolderButton.addEventListener("click", clearSelectedFolder);
elements.loadCommitsButton.addEventListener("click", loadCommits);
elements.commitSelect.addEventListener("change", () => {
  elements.explainCommitButton.disabled = !elements.commitSelect.value || Boolean(state.repoBundle);
});
elements.explainCommitButton.addEventListener("click", explainSelectedCommit);
elements.scanButton.addEventListener("click", scanRepo);
elements.form.addEventListener("submit", generateExplainer);
elements.deckButton.addEventListener("click", downloadPitchDeck);
elements.renderButton.addEventListener("click", renderVideo);
elements.copyMermaidButton.addEventListener("click", copyMermaid);
elements.chartButton.addEventListener("click", sendToMermaidChart);
installRailNavigation();
updateRepoSourceUi();
loadHealth();
