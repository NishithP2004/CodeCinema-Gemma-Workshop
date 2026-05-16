const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { ensureDir, escapeXml, clipText } = require("./utils");

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

function diagramPreviewSvg(mermaidCode) {
  const nodes = extractDiagramNodes(mermaidCode);
  const boxWidth = 250;
  const gap = 48;
  const startX = 104;
  const y = 660;

  return nodes
    .map((node, index) => {
      const x = startX + index * (boxWidth + gap);
      const lines = wrapText(node, 24, 2);
      const arrow =
        index < nodes.length - 1
          ? `<path d="M ${x + boxWidth + 8} ${y + 44} L ${x + boxWidth + gap - 18} ${y + 44}" stroke="#2f6f73" stroke-width="5" stroke-linecap="round"/><path d="M ${x + boxWidth + gap - 20} ${y + 44} l -13 -10 v20 z" fill="#2f6f73"/>`
          : "";
      return `
        <g>
          <rect x="${x}" y="${y}" width="${boxWidth}" height="96" rx="8" fill="#eef8f6" stroke="#7fb7ae" stroke-width="2"/>
          ${lines
            .map(
              (line, lineIndex) =>
                `<text x="${x + 20}" y="${y + 40 + lineIndex * 26}" font-family="Inter, Arial, sans-serif" font-size="22" fill="#193533">${escapeXml(line)}</text>`
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
      const y = 824 + index * 42;
      return `<text x="106" y="${y}" font-family="Inter, Arial, sans-serif" font-size="23" fill="#4a5560">${escapeXml(
        `${citation.file}:${citation.startLine}-${citation.endLine}`
      )}</text>`;
    })
    .join("\n");
}

function svgForScene(scene, index, total, explanation) {
  const titleLines = wrapText(scene.title, 34, 2);
  const slideTextLines = wrapText(scene.slideText || scene.narration, 40, 5);
  const visualLines = wrapText(scene.visual, 58, 2);
  const codeRefs = scene.codeRefs && scene.codeRefs.length ? scene.codeRefs : (explanation.citations || []).map((citation) => `${citation.file}:${citation.startLine}-${citation.endLine}`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#f8f7f2"/>
  <rect x="0" y="0" width="1920" height="92" fill="#202426"/>
  <text x="88" y="58" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700" fill="#f7f1df">CodeCinema</text>
  <text x="1710" y="58" font-family="Inter, Arial, sans-serif" font-size="26" fill="#f7f1df">Scene ${index + 1}/${total}</text>
  <rect x="86" y="142" width="700" height="368" rx="8" fill="#ffffff" stroke="#d8d4c8"/>
  ${titleLines
    .map(
      (line, lineIndex) =>
        `<text x="126" y="${210 + lineIndex * 58}" font-family="Inter, Arial, sans-serif" font-size="48" font-weight="800" fill="#202426">${escapeXml(line)}</text>`
    )
    .join("\n")}
  ${slideTextLines
    .map(
      (line, lineIndex) =>
        `<text x="128" y="${338 + lineIndex * 36}" font-family="Inter, Arial, sans-serif" font-size="25" fill="#3d4548">${escapeXml(line)}</text>`
    )
    .join("\n")}
  <rect x="836" y="142" width="996" height="368" rx="8" fill="#1f2527"/>
  <text x="880" y="202" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="700" fill="#f7f1df">Visual plan</text>
  ${visualLines
    .map(
      (line, lineIndex) =>
        `<text x="880" y="${260 + lineIndex * 36}" font-family="Inter, Arial, sans-serif" font-size="28" fill="#d9efe9">${escapeXml(line)}</text>`
    )
    .join("\n")}
  <text x="880" y="354" font-family="Inter, Arial, sans-serif" font-size="23" fill="#f3c56b">${escapeXml(clipText((explanation.mermaid && explanation.mermaid.title) || "Mermaid diagram", 80))}</text>
  ${wrapText((codeRefs || []).slice(0, 4).join("  |  "), 72, 3)
    .map(
      (line, lineIndex) =>
        `<text x="880" y="${410 + lineIndex * 31}" font-family="Menlo, Consolas, monospace" font-size="21" fill="#c7d0cf">${escapeXml(line)}</text>`
    )
    .join("\n")}
  <rect x="86" y="580" width="1746" height="220" rx="8" fill="#ffffff" stroke="#d8d4c8"/>
  <text x="106" y="632" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="700" fill="#202426">Flow diagram</text>
  ${diagramPreviewSvg(explanation.mermaid && explanation.mermaid.code)}
  <text x="106" y="878" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="700" fill="#202426">Grounded references</text>
  ${citationList(explanation.citations)}
  <rect x="86" y="1012" width="1746" height="10" rx="5" fill="#ded8c7"/>
  <rect x="86" y="1012" width="${Math.max(80, Math.round((1746 * (index + 1)) / total))}" height="10" rx="5" fill="#d85c48"/>
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
      await runCommand("sips", ["-s", "format", "png", svgPath, "--out", pngPath]);
      return;
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
      audio: audioPath ? `/artifacts/${id}/${path.basename(audioPath)}` : null,
      video: mp4Path ? `/artifacts/${id}/${path.basename(mp4Path)}` : null
    }
  };
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
  renderVideoBundle
};
