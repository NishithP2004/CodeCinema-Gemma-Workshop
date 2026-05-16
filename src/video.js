const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { ensureDir, escapeHtml, escapeXml, clipText } = require("./utils");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: options.shell || false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function commandExists(command) {
  try {
    await runCommand("which", [command]);
    return true;
  } catch {
    return false;
  }
}

function wrapText(text, maxChars, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  if (words.length && lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = `${clipText(lines[lines.length - 1], Math.max(10, maxChars - 1))}`;
  }
  return lines;
}

function extractDiagramNodes(mermaidCode) {
  const labels = [];
  const matches = String(mermaidCode || "").matchAll(/(?:\["([^"]+)"\]|\[([^\]\n]+)\]|\("([^"]+)"\)|\(([^)\n]+)\)|:\s*([^\n]+))/g);
  for (const match of matches) {
    const label = (match[1] || match[2] || match[3] || match[4] || match[5] || "").trim();
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 5) break;
  }

  if (!labels.length) {
    const lines = String(mermaidCode || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/[-=>|[\]();]/g, " ").trim())
      .filter((line) => line && !/^flowchart|^graph|^sequenceDiagram/i.test(line));
    for (const line of lines) {
      if (!labels.includes(line)) labels.push(clipText(line, 42));
      if (labels.length >= 5) break;
    }
  }

  return labels.length ? labels : ["Query", "Relevant code", "Explanation", "Narrated scenes"];
}

const SCENE_LAYOUTS = ["focus", "split", "evidence", "diagram"];

function getSceneLayout(scene, index) {
  const layout = String(scene?.layout || "").trim().toLowerCase();
  return SCENE_LAYOUTS.includes(layout) ? layout : SCENE_LAYOUTS[index % SCENE_LAYOUTS.length];
}

function getSceneEmphasis(scene) {
  const source = scene?.emphasis || scene?.visual || scene?.title || "Grounded code insight";
  return clipText(String(source).replace(/\s+/g, " ").trim(), 70);
}

function sceneRefs(scene, explanation, limit = 4) {
  const refs = scene?.codeRefs && scene.codeRefs.length
    ? scene.codeRefs
    : (explanation.citations || []).map((citation) => `${citation.file}:${citation.startLine}-${citation.endLine}`);
  return refs.slice(0, limit).map((ref) => String(ref));
}

function citationLabel(citation) {
  return `${citation.file}:${citation.startLine}-${citation.endLine}`;
}

function diagramPreviewSvg(mermaidCode, options = {}) {
  const nodes = extractDiagramNodes(mermaidCode);
  const boxWidth = options.boxWidth || 250;
  const boxHeight = options.boxHeight || 96;
  const gap = options.gap || 48;
  const startX = options.startX || 104;
  const y = options.y || 660;
  const fill = options.fill || "#eef8f6";
  const stroke = options.stroke || "#7fb7ae";
  const text = options.text || "#193533";
  const arrowColor = options.arrowColor || "#2f6f73";

  return nodes
    .map((node, index) => {
      const x = startX + index * (boxWidth + gap);
      const lines = wrapText(node, 24, 2);
      const arrow =
        index < nodes.length - 1
          ? `<path d="M ${x + boxWidth + 8} ${y + 44} L ${x + boxWidth + gap - 18} ${y + 44}" stroke="${arrowColor}" stroke-width="5" stroke-linecap="round"/><path d="M ${x + boxWidth + gap - 20} ${y + 44} l -13 -10 v20 z" fill="${arrowColor}"/>`
          : "";
      return `
        <g>
          <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
          ${lines
            .map(
              (line, lineIndex) =>
                `<text x="${x + 20}" y="${y + 40 + lineIndex * 26}" font-family="Inter, Arial, sans-serif" font-size="22" fill="${text}">${escapeXml(line)}</text>`
            )
            .join("")}
          ${arrow}
        </g>`;
    })
    .join("\n");
}

function citationList(citations) {
  return (citations || [])
    .slice(0, 4)
    .map((citation, index) => {
      const x = index % 2 === 0 ? 620 : 1120;
      const y = index < 2 ? 914 : 956;
      return `<text x="${x}" y="${y}" font-family="Menlo, Consolas, monospace" font-size="20" fill="#4a5560">${escapeXml(citationLabel(citation))}</text>`;
    })
    .join("\n");
}

function svgForScene(scene, index, total, explanation) {
  const layout = getSceneLayout(scene, index);
  const titleLines = wrapText(scene.title, 30, 2);
  const emphasisLines = wrapText(getSceneEmphasis(scene), 18, 2);
  const slideTextLines = wrapText(scene.slideText || scene.narration, 38, 4);
  const visualLines = wrapText(scene.visual || "Code walkthrough", 34, 3);
  const refs = sceneRefs(scene, explanation, 3);
  const mermaidTitle = (explanation.mermaid && explanation.mermaid.title) || "Mermaid diagram";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <pattern id="artifact-grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M 72 0 L 0 0 0 72" fill="none" stroke="#ded8c7" stroke-width="1" opacity="0.55"/>
    </pattern>
  </defs>
  <rect width="1920" height="1080" fill="#f8f7f2"/>
  <rect width="1920" height="1080" fill="url(#artifact-grid)" opacity="0.5"/>
  <rect x="0" y="0" width="154" height="1080" fill="#202426"/>
  <rect x="154" y="0" width="1766" height="18" fill="#d85c48"/>
  <text x="42" y="72" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#f7f1df">CC</text>
  <text x="42" y="972" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#f3c56b">${String(index + 1).padStart(2, "0")}</text>
  <text x="42" y="1010" font-family="Inter, Arial, sans-serif" font-size="18" fill="#d8d0bd">OF ${String(total).padStart(2, "0")}</text>
  <text x="196" y="82" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900" fill="#d85c48">CODECINEMA / ${escapeXml(layout.toUpperCase())}</text>
  <text x="1428" y="82" font-family="Inter, Arial, sans-serif" font-size="22" fill="#697174">${escapeXml(clipText(explanation.commit ? `Commit ${explanation.commit.shortSha}` : explanation.query || "Repository walkthrough", 52))}</text>

  <rect x="196" y="126" width="820" height="500" rx="8" fill="#fffdf8" stroke="#d8d4c8"/>
  <text x="236" y="184" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="900" fill="#2f6f73">ON-SCREEN POINT</text>
  ${titleLines
    .map(
      (line, lineIndex) =>
        `<text x="236" y="${260 + lineIndex * 58}" font-family="Inter, Arial, sans-serif" font-size="50" font-weight="900" fill="#202426">${escapeXml(line)}</text>`
    )
    .join("\n")}
  ${slideTextLines
    .map(
      (line, lineIndex) =>
        `<text x="238" y="${394 + lineIndex * 38}" font-family="Inter, Arial, sans-serif" font-size="28" fill="#3d4548">${escapeXml(line)}</text>`
    )
    .join("\n")}
  <rect x="236" y="544" width="300" height="44" rx="8" fill="#f3c56b"/>
  <text x="256" y="573" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="900" fill="#202426">${escapeXml(clipText(mermaidTitle, 28))}</text>

  <rect x="1064" y="126" width="660" height="500" rx="8" fill="#202426"/>
  <text x="1108" y="184" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="900" fill="#f3c56b">VISUAL ANCHOR</text>
  <rect x="1108" y="226" width="246" height="8" rx="4" fill="#d85c48"/>
  ${emphasisLines
    .map(
      (line, lineIndex) =>
        `<text x="1108" y="${304 + lineIndex * 58}" font-family="Inter, Arial, sans-serif" font-size="50" font-weight="900" fill="#f7f1df">${escapeXml(line)}</text>`
    )
    .join("\n")}
  ${visualLines
    .map(
      (line, lineIndex) =>
        `<text x="1112" y="${444 + lineIndex * 34}" font-family="Inter, Arial, sans-serif" font-size="25" fill="#d9efe9">${escapeXml(line)}</text>`
    )
    .join("\n")}
  ${wrapText(refs.join("  |  "), 44, 3)
    .map(
      (line, lineIndex) =>
        `<text x="1112" y="${552 + lineIndex * 29}" font-family="Menlo, Consolas, monospace" font-size="19" fill="#c7d0cf">${escapeXml(line)}</text>`
    )
    .join("\n")}

  <rect x="196" y="676" width="1528" height="150" rx="8" fill="#ffffff" stroke="#d8d4c8"/>
  <text x="236" y="730" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900" fill="#202426">Flow sketch</text>
  ${diagramPreviewSvg(explanation.mermaid && explanation.mermaid.code, {
    startX: 458,
    y: 706,
    boxWidth: 210,
    boxHeight: 84,
    gap: 32
  })}

  <rect x="196" y="862" width="1528" height="120" rx="8" fill="#fffdf8" stroke="#d8d4c8"/>
  <text x="236" y="918" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900" fill="#202426">Grounded references</text>
  ${citationList(explanation.citations)}
  <rect x="196" y="1020" width="1528" height="10" rx="5" fill="#ded8c7"/>
  <rect x="196" y="1020" width="${Math.max(80, Math.round((1528 * (index + 1)) / total))}" height="10" rx="5" fill="#d85c48"/>
</svg>`;
}

async function synthesizeNarration(narration, outDir, warnings) {
  const narrationPath = path.join(outDir, "narration.txt");
  await fs.writeFile(narrationPath, narration, "utf8");

  const provider = (process.env.TTS_PROVIDER || "auto").toLowerCase();
  const customCommand = process.env.TTS_COMMAND;

  if ((provider === "command" || (provider === "auto" && customCommand)) && customCommand) {
    const outputPath = path.join(outDir, "narration.wav");
    await runCommand(customCommand, [], {
      shell: true,
      env: {
        CODECINEMA_TTS_INPUT: narrationPath,
        CODECINEMA_TTS_OUTPUT: outputPath
      }
    });
    return outputPath;
  }

  if ((provider === "piper" || provider === "auto") && process.env.PIPER_MODEL && (await commandExists("piper"))) {
    const outputPath = path.join(outDir, "narration.wav");
    await runCommand("piper", ["--model", process.env.PIPER_MODEL, "--output_file", outputPath], {
      input: narration
    });
    return outputPath;
  }

  if ((provider === "say" || provider === "auto") && (await commandExists("say"))) {
    const outputPath = path.join(outDir, "narration.aiff");
    await runCommand("say", ["-f", narrationPath, "-o", outputPath]);
    if (provider === "auto") warnings.push("Piper/Kokoro command was not configured, so CodeCinema used macOS local TTS via say.");
    return outputPath;
  }

  warnings.push("No local TTS provider was available. The storyboard artifacts were generated without narration audio.");
  return null;
}

async function audioDuration(audioPath) {
  if (!audioPath || !(await commandExists("ffprobe"))) return null;
  try {
    const result = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath
    ]);
    const duration = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

async function convertSlideToPng(svgPath, pngPath) {
  try {
    await runCommand("ffmpeg", ["-y", "-i", svgPath, "-frames:v", "1", pngPath]);
    return;
  } catch (error) {
    if (await commandExists("sips")) {
      try {
        await runCommand("sips", ["-s", "format", "png", svgPath, "--out", pngPath]);
        return;
      } catch {
        // Some macOS builds report sips support for SVG but fail at runtime.
      }
    }
    if (await commandExists("qlmanage")) {
      const quickLookDir = path.join(path.dirname(pngPath), `.ql-${path.basename(svgPath)}-${Date.now()}`);
      await ensureDir(quickLookDir);
      await runCommand("qlmanage", ["-t", "-s", "1920", "-o", quickLookDir, svgPath]);
      const quickLookPng = path.join(quickLookDir, `${path.basename(svgPath)}.png`);
      await runCommand("ffmpeg", ["-y", "-i", quickLookPng, "-vf", "crop=1920:1080:0:0,scale=1920:1080", pngPath]);
      return;
    }
    throw error;
  }
}

async function renderMp4({ slides, audioPath, outDir, durationSeconds, warnings }) {
  if (!(await commandExists("ffmpeg"))) {
    warnings.push("ffmpeg was not found, so MP4 rendering was skipped.");
    return null;
  }

  const pngPaths = [];
  for (const slide of slides) {
    const pngPath = slide.replace(/\.svg$/i, ".png");
    await convertSlideToPng(slide, pngPath);
    pngPaths.push(pngPath);
  }

  const perSlide = Math.max(3, durationSeconds / Math.max(1, pngPaths.length));
  const concatPath = path.join(outDir, "slides.ffconcat");
  const concatBody = [
    "ffconcat version 1.0",
    ...pngPaths.flatMap((pngPath) => [`file '${escapeConcatPath(pngPath)}'`, `duration ${perSlide.toFixed(3)}`]),
    `file '${escapeConcatPath(pngPaths[pngPaths.length - 1])}'`
  ].join("\n");
  await fs.writeFile(concatPath, concatBody, "utf8");

  const outputPath = path.join(outDir, "codec-cinema-explainer.mp4");
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath];
  if (audioPath) {
    args.push("-i", audioPath, "-shortest");
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-t", String(durationSeconds));
  }
  args.push(
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath
  );

  await runCommand("ffmpeg", args);
  return outputPath;
}

async function renderVideoBundle(explanation, options = {}) {
  if (!explanation || !Array.isArray(explanation.scenes)) throw new Error("An explanation with scenes is required.");

  const artifactRoot = path.join(process.cwd(), "artifacts");
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outDir = path.join(artifactRoot, id);
  const slidesDir = path.join(outDir, "slides");
  const warnings = [];
  await ensureDir(slidesDir);

  const narration = explanation.narration || explanation.scenes.map((scene) => scene.narration).join("\n\n");
  await fs.writeFile(path.join(outDir, "storyboard.json"), JSON.stringify(explanation, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "diagram.mmd"), explanation.mermaid?.code || "", "utf8");

  const slides = [];
  for (let index = 0; index < explanation.scenes.length; index += 1) {
    const slidePath = path.join(slidesDir, `scene-${String(index + 1).padStart(2, "0")}.svg`);
    await fs.writeFile(slidePath, svgForScene(explanation.scenes[index], index, explanation.scenes.length, explanation), "utf8");
    slides.push(slidePath);
  }

  const audioPath = await synthesizeNarration(narration, outDir, warnings).catch((error) => {
    warnings.push(`TTS failed: ${clipText(error.message, 220)}`);
    return null;
  });
  const measuredDuration = await audioDuration(audioPath);
  const estimatedDuration = explanation.scenes.reduce((sum, scene) => sum + Math.max(6, scene.narration.split(/\s+/).length / 2.35), 0);
  const durationSeconds = Math.max(8, measuredDuration || estimatedDuration);

  const deckPath = await renderPitchDeck(explanation, { outDir }).catch((error) => {
    warnings.push(`Pitch deck export failed: ${clipText(error.message, 220)}`);
    return null;
  });

  const mp4Path = await renderMp4({ slides, audioPath, outDir, durationSeconds, warnings }).catch((error) => {
    warnings.push(`MP4 rendering failed: ${clipText(error.message, 260)}`);
    return null;
  });

  return {
    id,
    durationSeconds,
    warnings,
    files: {
      storyboard: `/artifacts/${id}/storyboard.json`,
      narration: `/artifacts/${id}/narration.txt`,
      diagram: `/artifacts/${id}/diagram.mmd`,
      firstSlide: `/artifacts/${id}/slides/scene-01.svg`,
      pitchDeck: deckPath ? `/artifacts/${id}/${path.basename(deckPath)}` : null,
      audio: audioPath ? `/artifacts/${id}/${path.basename(audioPath)}` : null,
      video: mp4Path ? `/artifacts/${id}/${path.basename(mp4Path)}` : null
    }
  };
}

function deckSceneHtml(scene, index, explanation) {
  const layout = getSceneLayout(scene, index);
  const refs = sceneRefs(scene, explanation, 3)
    .map((ref) => `<span>${escapeHtml(ref)}</span>`)
    .join("");
  const narrationLines = wrapText(scene.narration || "", 96, 2)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");

  return `
    <section class="slide scene-slide layout-${escapeHtml(layout)}">
      <div class="scene-chrome">
        <span>Scene ${String(index + 1).padStart(2, "0")}</span>
        <span>${escapeHtml(layout)}</span>
      </div>
      <div class="scene-content">
        <div class="scene-copy">
          <div class="slide-kicker">${escapeHtml(getSceneEmphasis(scene))}</div>
          <h2>${escapeHtml(scene.title)}</h2>
          <p class="slide-text">${escapeHtml(scene.slideText || scene.narration || "")}</p>
          <div class="narration-notes">${narrationLines}</div>
        </div>
        <aside class="visual-board">
          <div class="visual-label">Visual</div>
          <strong>${escapeHtml(scene.visual || "Code walkthrough")}</strong>
          <div class="visual-rule"></div>
          <div class="refs">${refs}</div>
        </aside>
      </div>
    </section>`;
}

async function renderPitchDeck(explanation, options = {}) {
  if (!explanation || !Array.isArray(explanation.scenes)) throw new Error("An explanation with scenes is required.");

  const artifactRoot = path.join(process.cwd(), "artifacts");
  const id = options.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outDir = options.outDir || path.join(artifactRoot, id);
  await ensureDir(outDir);

  const citations = (explanation.citations || [])
    .slice(0, 8)
    .map(
      (citation) =>
        `<li><strong>${escapeHtml(citation.file)}:${citation.startLine}-${citation.endLine}</strong><span>${escapeHtml(citation.why || "")}</span></li>`
    )
    .join("");
  const diagramSteps = extractDiagramNodes(explanation.mermaid?.code)
    .slice(0, 5)
    .map((node, index) => `<span><b>${String(index + 1).padStart(2, "0")}</b>${escapeHtml(node)}</span>`)
    .join("");
  const coverTitle = explanation.commit ? `Commit ${explanation.commit.shortSha}` : "CodeCinema";
  const coverSubtitle = explanation.commit
    ? explanation.commit.message || explanation.query || "Diff-grounded changelog walkthrough"
    : explanation.query || "Generated code explainer";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeCinema Pitch Deck</title>
    <style>
      :root {
        --ink: #202426;
        --muted: #626b6f;
        --paper: #f8f7f2;
        --paper-strong: #fffdf8;
        --deep: #1f2527;
        --deep-2: #171c1e;
        --coral: #d85c48;
        --gold: #f3c56b;
        --teal: #2f6f73;
        --teal-soft: #e8f4f1;
        --line: #d8d4c8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--deep-2);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .deck {
        display: grid;
        gap: 32px;
        padding: 32px;
        background:
          linear-gradient(90deg, rgba(247, 241, 223, 0.04) 1px, transparent 1px),
          linear-gradient(0deg, rgba(247, 241, 223, 0.04) 1px, transparent 1px),
          var(--deep-2);
        background-size: 56px 56px;
      }
      .slide {
        width: min(1280px, 100%);
        aspect-ratio: 16 / 9;
        margin: 0 auto;
        position: relative;
        overflow: hidden;
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: clamp(32px, 4vw, 58px);
        display: flex;
        flex-direction: column;
        justify-content: center;
        page-break-after: always;
      }
      .slide::before {
        content: "";
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(90deg, rgba(216, 212, 200, 0.38) 1px, transparent 1px),
          linear-gradient(0deg, rgba(216, 212, 200, 0.38) 1px, transparent 1px);
        background-size: 64px 64px;
        opacity: 0.32;
        pointer-events: none;
      }
      .slide > * {
        position: relative;
        z-index: 1;
      }
      .cover {
        display: grid;
        grid-template-columns: 1.04fr 0.96fr;
        gap: clamp(28px, 4vw, 64px);
        background:
          linear-gradient(90deg, rgba(216, 92, 72, 0.18), transparent 44%),
          var(--deep);
        color: #f7f1df;
      }
      .cover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 18px;
        background: var(--coral);
      }
      .slide-kicker {
        color: var(--coral);
        font-size: clamp(13px, 1.25vw, 17px);
        font-weight: 900;
        text-transform: uppercase;
        margin-bottom: 18px;
      }
      h1, h2 {
        margin: 0;
        line-height: 1.02;
        letter-spacing: 0;
      }
      h1 { font-size: clamp(52px, 8vw, 116px); max-width: 760px; }
      h2 { font-size: clamp(38px, 5vw, 76px); max-width: 760px; }
      .slide-text {
        max-width: 760px;
        font-size: clamp(24px, 3vw, 40px);
        line-height: 1.18;
        color: var(--muted);
        margin: 24px 0 0;
      }
      .cover .slide-text { color: #d8d0bd; }
      .cover-proof {
        align-self: end;
        display: grid;
        gap: 14px;
        border: 1px solid rgba(247, 241, 223, 0.18);
        border-radius: 8px;
        padding: 24px;
        background: rgba(247, 241, 223, 0.07);
      }
      .cover-proof span {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        color: #d8d0bd;
        font-weight: 800;
      }
      .cover-proof b { color: var(--gold); }
      .scene-slide {
        justify-content: stretch;
      }
      .scene-chrome {
        display: flex;
        justify-content: space-between;
        color: var(--muted);
        font-size: 13px;
        font-weight: 900;
        text-transform: uppercase;
        margin-bottom: clamp(18px, 3vw, 34px);
      }
      .scene-content {
        flex: 1;
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.72fr);
        gap: clamp(28px, 4vw, 56px);
        align-items: stretch;
      }
      .scene-copy {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
      }
      .narration-notes {
        margin-top: auto;
        color: var(--muted);
        font-size: clamp(15px, 1.4vw, 20px);
        line-height: 1.38;
        max-width: 760px;
      }
      .narration-notes p {
        margin: 8px 0 0;
      }
      .refs {
        display: grid;
        gap: 10px;
      }
      .refs span {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 9px 10px;
        color: #d8d0bd;
        font-family: Menlo, Consolas, monospace;
        font-size: clamp(11px, 1.1vw, 14px);
        overflow-wrap: anywhere;
      }
      .visual-board {
        border-radius: 8px;
        background: var(--deep);
        color: #f7f1df;
        padding: clamp(24px, 3vw, 34px);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        min-width: 0;
      }
      .visual-label {
        color: var(--gold);
        font-size: 13px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .visual-board strong {
        display: block;
        margin-top: 22px;
        font-size: clamp(28px, 3.2vw, 48px);
        line-height: 1.04;
        overflow-wrap: anywhere;
      }
      .visual-rule {
        width: 46%;
        height: 8px;
        margin: 28px 0;
        border-radius: 8px;
        background: var(--coral);
      }
      .layout-focus .scene-content {
        grid-template-columns: minmax(0, 1fr);
      }
      .layout-focus .visual-board {
        position: absolute;
        right: clamp(32px, 4vw, 58px);
        bottom: clamp(32px, 4vw, 58px);
        width: min(420px, 38%);
        min-height: 250px;
      }
      .layout-focus .scene-copy {
        max-width: 760px;
      }
      .layout-evidence .visual-board {
        background: var(--paper-strong);
        color: var(--ink);
        border: 1px solid var(--line);
      }
      .layout-evidence .visual-board .refs span {
        color: var(--muted);
        background: #fbfaf6;
      }
      .layout-diagram .scene-content {
        grid-template-columns: minmax(0, 0.85fr) minmax(420px, 1fr);
      }
      .diagram-frame {
        display: grid;
        grid-template-columns: 0.7fr 1fr;
        gap: 28px;
        align-items: stretch;
        margin-top: 22px;
      }
      .diagram-steps {
        display: grid;
        gap: 12px;
      }
      .diagram-steps span {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--paper-strong);
        font-weight: 800;
      }
      .diagram-steps b {
        color: var(--coral);
        font-family: Menlo, Consolas, monospace;
      }
      .diagram pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 430px;
        overflow: auto;
        background: var(--deep);
        color: #f7f1df;
        border-radius: 8px;
        padding: 24px;
        font-size: clamp(13px, 1.35vw, 18px);
        line-height: 1.35;
        margin: 0;
      }
      .citations ul {
        margin: 28px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .citations li {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 15px;
        background: var(--paper-strong);
        min-width: 0;
      }
      .citations strong, .citations span {
        display: block;
        overflow-wrap: anywhere;
      }
      .citations strong {
        color: var(--teal);
        font-family: Menlo, Consolas, monospace;
        font-size: clamp(12px, 1.1vw, 15px);
      }
      .citations span {
        color: var(--muted);
        margin-top: 7px;
        font-size: clamp(13px, 1.15vw, 16px);
        line-height: 1.35;
      }
      @media (max-width: 780px) {
        .deck { padding: 14px; gap: 18px; }
        .cover, .scene-content, .diagram-frame, .citations ul {
          grid-template-columns: 1fr;
        }
        .layout-focus .visual-board {
          position: relative;
          right: auto;
          bottom: auto;
          width: 100%;
          min-height: 0;
        }
        .narration-notes {
          display: none;
        }
      }
      @media print {
        body { background: #fff; }
        .deck { padding: 0; gap: 0; }
        .slide { width: 100vw; height: 100vh; border: 0; border-radius: 0; }
      }
    </style>
  </head>
  <body>
    <main class="deck">
      <section class="slide cover">
        <div>
          <div class="slide-kicker">Local AI repository explainer</div>
          <h1>${escapeHtml(coverTitle)}</h1>
          <p class="slide-text">${escapeHtml(coverSubtitle)}</p>
        </div>
        <div class="cover-proof">
          <span><b>Private code</b> stays local</span>
          <span><b>Gemma</b> narrates from evidence</span>
          <span><b>Artifacts</b> export as deck and video</span>
        </div>
      </section>
      ${explanation.scenes.map((scene, index) => deckSceneHtml(scene, index, explanation)).join("")}
      <section class="slide diagram">
        <div class="slide-kicker">Diagram</div>
        <h2>${escapeHtml(explanation.mermaid?.title || "Flow diagram")}</h2>
        <div class="diagram-frame">
          <div class="diagram-steps">${diagramSteps}</div>
          <pre>${escapeHtml(explanation.mermaid?.code || "")}</pre>
        </div>
      </section>
      <section class="slide citations">
        <div class="slide-kicker">References</div>
        <h2>Grounded in code</h2>
        <ul>${citations}</ul>
      </section>
    </main>
  </body>
</html>`;

  const deckPath = path.join(outDir, "codec-cinema-pitch-deck.html");
  await fs.writeFile(deckPath, html, "utf8");
  return deckPath;
}

async function createMermaidChart(mermaid) {
  const url = process.env.MERMAID_CHART_API_URL;
  const key = process.env.MERMAID_CHART_API_KEY;
  if (!url || !key) {
    return {
      configured: false,
      message: "MERMAID_CHART_API_URL and MERMAID_CHART_API_KEY are not configured.",
      diagram: mermaid?.code || ""
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      title: mermaid?.title || "CodeCinema diagram",
      diagram: mermaid?.code || ""
    })
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Mermaid Chart API returned ${response.status}: ${clipText(body, 240)}`);
  try {
    return { configured: true, ...JSON.parse(body) };
  } catch {
    return { configured: true, raw: body };
  }
}

module.exports = {
  commandExists,
  createMermaidChart,
  renderPitchDeck,
  renderVideoBundle
};
