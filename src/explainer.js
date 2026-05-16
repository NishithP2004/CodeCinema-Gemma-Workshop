const { chatWithOllama, getOllamaConfig } = require("./ollamaClient");
const { retrieveChunks, scanRepo, scanRepoBundle } = require("./repoScanner");
const { chunksFromCommitDiff, getCommitDiff } = require("./git");
const { clipText, normalizeWhitespace } = require("./utils");

const DIAGRAM_PREFIXES = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "erDiagram",
  "journey",
  "gantt"
];

const SCENE_LAYOUTS = ["focus", "split", "evidence", "diagram"];

const STORYBOARD_SYSTEM_PROMPT = [
  "You are CodeCinema's Hyperframes storyboard director: a cinematic technical educator, senior software architect, and ruthless slide designer.",
  "Your job is to turn code evidence into premium 16:9 video frames and a downloadable pitch deck, not prose slides.",
  "Design the hero frame first: one idea, one visual anchor, one short on-screen sentence, and grounded citations.",
  "Think like a documentary editor: compact slide text, useful visuals, intentional layouts, and spoken narration that carries the detail.",
  "Never write dense slide paragraphs. If a concept needs more detail, split it into another scene instead of making a crowded scene.",
  "Avoid generic card grids and default tech-pitch filler. Make every scene feel like a composed technical artifact.",
  "Only cite files and line ranges that appear in the provided context. Return only valid JSON."
].join(" ");

function contextFromChunks(chunks) {
  return chunks
    .map((chunk, index) => {
      const body = clipText(chunk.text, 1600);
      return [
        `[chunk:${index}] ${chunk.file}:${chunk.startLine}-${chunk.endLine} (${chunk.language}, score ${chunk.score})`,
        "```" + chunk.language,
        body,
        "```"
      ].join("\n");
    })
    .join("\n\n");
}

function extractJson(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("The model returned an empty response.");

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;

  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw firstError;
  }
}

function citationFromChunk(chunk, why = "Relevant retrieved code") {
  return {
    file: chunk.file,
    startLine: chunk.startLine,
    endLine: Math.min(chunk.endLine, chunk.startLine + 40),
    why
  };
}

function extractSignals(text) {
  const source = String(text || "");
  const patterns = [
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /class\s+([A-Za-z_$][\w$]*)/g
  ];
  const signals = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!signals.includes(match[1])) signals.push(match[1]);
      if (signals.length >= 8) return signals;
    }
  }
  return signals;
}

function describeKnownFile(file) {
  if (file.endsWith("src/repoScanner.js")) {
    return "validates the repo path, skips noisy folders, filters large or binary files, chunks readable source by line range, records language stats, and ranks chunks against the query.";
  }
  if (file.endsWith("src/video.js")) {
    return "turns scenes into SVG slides, writes storyboard artifacts, chooses a local TTS provider, measures narration length, and asks ffmpeg to assemble the MP4.";
  }
  if (file.endsWith("src/explainer.js")) {
    return "connects retrieval to Gemma, constrains the model to JSON, validates citations, creates Mermaid fallback diagrams, and builds the narration timeline.";
  }
  if (file.endsWith("src/server.js")) {
    return "exposes the local HTTP API for scanning, explanation generation, Mermaid Chart sync, static assets, and video rendering.";
  }
  if (file.endsWith("public/app.js")) {
    return "drives the browser workflow for scanning, asking Gemma, previewing Mermaid, rendering scenes, and showing exported video assets.";
  }
  return "";
}

function createGroundedAnswer(query, chunks) {
  const byFile = new Map();
  for (const chunk of chunks) {
    if (!byFile.has(chunk.file)) byFile.set(chunk.file, []);
    byFile.get(chunk.file).push(chunk);
  }

  const sections = Array.from(byFile.entries())
    .slice(0, 5)
    .map(([file, fileChunks]) => {
      const signals = Array.from(new Set(fileChunks.flatMap((chunk) => extractSignals(chunk.text)))).slice(0, 6);
      const knownDescription = describeKnownFile(file);
      const signalText = signals.length ? ` Key symbols: ${signals.map((signal) => `\`${signal}\``).join(", ")}.` : "";
      return `- \`${file}\` ${knownDescription || "contains one of the strongest retrieved matches for this question."}${signalText}`;
    });

  if (!sections.length) return `I could not retrieve enough code to answer "${query}" with confidence.`;

  return [
    `For "${query}", CodeCinema grounds the answer in the retrieved implementation rather than only in a high-level summary.`,
    ...sections,
    "The practical flow is: scan the repo, keep only readable source files, split them into cited chunks, pass the strongest chunks to Gemma, validate the structured response, then turn the answer into Mermaid, narration scenes, and video assets."
  ].join("\n");
}

function answerLooksWeak(answer, query) {
  const text = String(answer || "").toLowerCase();
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((term) => term.length > 3);
  const queryHits = terms.filter((term) => text.includes(term)).length;
  return (
    text.length < 180 ||
    queryHits === 0 ||
    text.includes("readme file describes") ||
    text.includes("install dependencies") ||
    text.includes("provides examples of how to use the tool")
  );
}

function normalizeCitation(citation, chunks) {
  const file = String(citation?.file || "").trim();
  const matching = chunks.find((chunk) => chunk.file === file) || chunks[0];
  if (!matching) return null;

  const startLine = Number(citation?.startLine || citation?.lineStart || matching.startLine);
  const endLine = Number(citation?.endLine || citation?.lineEnd || Math.min(matching.endLine, startLine + 40));

  return {
    file: matching.file,
    startLine: Math.max(matching.startLine, Math.min(startLine, matching.endLine)),
    endLine: Math.max(startLine, Math.min(endLine, matching.endLine)),
    why: clipText(citation?.why || citation?.reason || "Supports this part of the explanation", 180)
  };
}

function normalizeMermaid(mermaid, query, chunks) {
  const code = String(mermaid?.code || "").trim();
  const startsCorrectly = DIAGRAM_PREFIXES.some((prefix) => code.startsWith(prefix));
  if (startsCorrectly) {
    return {
      title: clipText(mermaid?.title || "Code flow", 80),
      type: clipText(mermaid?.type || code.split(/\s+/)[0], 40),
      code
    };
  }

  return createFallbackMermaid(query, chunks);
}

function cleanNarration(value) {
  return String(value || "")
    .replace(/`/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createSlideText(value, fallback = "Code evidence drives the explanation.") {
  const cleaned = cleanNarration(value || fallback)
    .replace(/\bKey symbols?:.*$/i, "")
    .replace(/\bThe practical flow is:\s*/i, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return fallback;
  if (words.length <= 18 && cleaned.length <= 140) return cleaned;
  return `${words.slice(0, 18).join(" ")}...`;
}

function normalizeSceneLayout(value, index) {
  const layout = String(value || "").trim().toLowerCase();
  return SCENE_LAYOUTS.includes(layout) ? layout : SCENE_LAYOUTS[index % SCENE_LAYOUTS.length];
}

function createSceneEmphasis(scene, fallback) {
  const raw = scene?.emphasis || scene?.visual || scene?.title || fallback || "Grounded code insight";
  const words = cleanNarration(raw).split(/\s+/).filter(Boolean);
  if (!words.length) return "Grounded code insight";
  return clipText(words.slice(0, 7).join(" "), 70);
}

function createFallbackMermaid(query, chunks) {
  const topFiles = chunks.slice(0, 5).map((chunk) => chunk.file);
  const uniqueFiles = Array.from(new Set(topFiles));
  const nodes = uniqueFiles.length ? uniqueFiles : ["Selected source files"];
  const lines = [
    "flowchart TD",
    `  Q["${escapeMermaidLabel(clipText(query, 60) || "User query")}"] --> R["Retrieve relevant code"]`,
    '  R --> G["Gemma explains with citations"]',
    '  G --> V["Narrated video scenes"]'
  ];
  nodes.forEach((file, index) => {
    lines.push(`  R --> F${index}["${escapeMermaidLabel(file)}"]`);
  });
  return {
    title: "Repository explanation flow",
    type: "flowchart",
    code: lines.join("\n")
  };
}

function escapeMermaidLabel(value) {
  return String(value || "").replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")");
}

function normalizeScenes(scenes, answer, citations, mermaid) {
  const normalized = Array.isArray(scenes)
    ? scenes
        .slice(0, 6)
        .map((scene, index) => ({
          title: clipText(scene?.title || `Scene ${index + 1}`, 80),
          layout: normalizeSceneLayout(scene?.layout, index),
          emphasis: createSceneEmphasis(scene, scene?.slideText || answer),
          narration: clipText(cleanNarration(scene?.narration || scene?.script || answer), 620),
          slideText: clipText(
            createSlideText(scene?.slideText || scene?.onScreenText || scene?.summary || scene?.narration || scene?.script || answer),
            160
          ),
          visual: clipText(scene?.visual || mermaid.title || "Architecture diagram", 140),
          codeRefs: Array.isArray(scene?.codeRefs) ? scene.codeRefs.slice(0, 2) : []
        }))
        .filter((scene) => scene.narration)
    : [];

  if (normalized.length) return normalized;

  const refText = citations.slice(0, 2).map((citation) => `${citation.file}:${citation.startLine}-${citation.endLine}`);
  return [
    {
      title: "Question and retrieval",
      layout: "focus",
      emphasis: "Find the evidence",
      narration: "CodeCinema starts by scanning the repository and retrieving the files that best match the user question.",
      slideText: "Find the code that answers the question.",
      visual: "Repository map and search hits",
      codeRefs: refText
    },
    {
      title: "Main explanation",
      layout: "split",
      emphasis: "Explain the flow",
      narration: clipText(cleanNarration(answer), 620),
      slideText: createSlideText(answer),
      visual: mermaid.title,
      codeRefs: refText
    },
    {
      title: "References to inspect",
      layout: "evidence",
      emphasis: "Trace every claim",
      narration: "The answer is grounded in specific files and line ranges so the viewer can jump from the video back into the implementation.",
      slideText: "Every claim links back to code.",
      visual: "Citation list",
      codeRefs: citations.slice(0, 4).map((citation) => `${citation.file}:${citation.startLine}-${citation.endLine}`)
    }
  ];
}

function createTimeline(scenes) {
  return scenes.map((scene, index) => ({
    label: scene.title,
    seconds: Math.max(7, Math.min(18, Math.ceil(scene.narration.split(/\s+/).length / 2.4))),
    scene: index + 1
  }));
}

function createNarration(scenes) {
  return scenes.map((scene, index) => `Scene ${index + 1}: ${scene.title}.\n${scene.narration}`).join("\n\n");
}

function fallbackExplanation(query, chunks, error) {
  const citations = chunks.slice(0, 6).map((chunk) => citationFromChunk(chunk));
  const mermaid = createFallbackMermaid(query, chunks);
  const answer = chunks.length
    ? createGroundedAnswer(query, chunks)
    : `I could not find matching code for "${query}" in the scanned files. Try a more specific phrase or point CodeCinema at a larger repository path.`;
  const scenes = normalizeScenes([], answer, citations, mermaid);

  return {
    answer,
    citations,
    mermaid,
    scenes,
    timeline: createTimeline(scenes),
    narration: createNarration(scenes),
    warnings: [clipText(error?.message || String(error || "Gemma response fallback used."), 240)]
  };
}

function fallbackCommitExplanation(commitDiff, chunks, error) {
  const citations = chunks.slice(0, 6).map((chunk) => citationFromChunk(chunk, "Changed in this commit"));
  const changedFiles = commitDiff.files.slice(0, 8).map((file) => `${file.status} ${file.file}`).join(", ");
  const categories = [];
  const fileNames = commitDiff.files.map((file) => file.file);
  if (fileNames.some((file) => /^src\//.test(file))) categories.push("backend and app logic");
  if (fileNames.some((file) => /^public\//.test(file))) categories.push("browser UI");
  if (fileNames.some((file) => /README|\.env|package\.json|\.gitignore/.test(file))) categories.push("project setup and documentation");
  if (fileNames.some((file) => /test|spec/i.test(file))) categories.push("tests");
  const answer = [
    `Commit ${commitDiff.commit.shortSha} changes ${commitDiff.files.length} file${commitDiff.files.length === 1 ? "" : "s"}.`,
    commitDiff.commit.message ? `Commit message: ${commitDiff.commit.message.split(/\r?\n/)[0]}` : "",
    categories.length ? `Main areas touched: ${categories.join(", ")}.` : "",
    changedFiles ? `Changed files: ${changedFiles}.` : "",
    "Review the cited diff sections to see the concrete additions, removals, and renamed paths."
  ]
    .filter(Boolean)
    .join("\n");
  const mermaid = {
    title: "Commit change flow",
    type: "flowchart",
    code: [
      "flowchart TD",
      `  A["Commit ${commitDiff.commit.shortSha}"] --> B["Changed files"]`,
      '  B --> C["Behavior impact"]',
      '  C --> D["Review risks"]'
    ].join("\n")
  };
  const scenes = normalizeScenes([], answer, citations, mermaid);

  return {
    answer,
    citations,
    mermaid,
    scenes,
    timeline: createTimeline(scenes),
    narration: createNarration(scenes),
    warnings: [clipText(error?.message || String(error || "Gemma commit fallback used."), 240)]
  };
}

function commitAnswerLooksWeak(answer, commitDiff) {
  const text = String(answer || "").toLowerCase();
  if (text.length < 180) return true;

  const concreteFileHit = commitDiff.files
    .slice(0, 12)
    .some((file) => text.includes(file.file.toLowerCase()) || text.includes(file.file.split("/").pop().toLowerCase()));
  if (!concreteFileHit) return true;

  const vaguePhrases = [
    "significantly enhances",
    "improves maintainability",
    "improves testability",
    "improved type safety",
    "monolithic setup",
    "scalability",
    "robust error handling"
  ];
  return vaguePhrases.some((phrase) => text.includes(phrase)) && !text.includes(commitDiff.commit.shortSha.toLowerCase());
}

function enrichCitations(citations, chunks) {
  return citations.map((citation) => {
    const matching =
      chunks.find(
        (chunk) =>
          chunk.file === citation.file &&
          Number(citation.startLine) >= chunk.startLine &&
          Number(citation.startLine) <= chunk.endLine
      ) || chunks.find((chunk) => chunk.file === citation.file);
    return {
      ...citation,
      preview: matching ? matching.preview : ""
    };
  });
}

async function generateExplanation({ repoPath, repoBundle, query, mode = "junior developer" }) {
  if (!query || !query.trim()) throw new Error("A user query is required.");

  const repo = repoBundle ? scanRepoBundle(repoBundle) : await scanRepo(repoPath);
  let retrieved = retrieveChunks(query, repo.chunks, { limit: 8 });
  if (!retrieved.length) retrieved = repo.chunks.slice(0, 8).map((chunk) => ({ ...chunk, score: 0 }));

  const context = contextFromChunks(retrieved);
  const { host, model } = getOllamaConfig();
  const messages = [
    {
      role: "system",
      content: STORYBOARD_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: [
        `User query: ${query}`,
        `Audience mode: ${mode}`,
        "",
        "Repository context:",
        context || "No matching context was retrieved.",
        "",
        "Return ONLY valid JSON with this exact shape:",
        "{",
        '  "answer": "A concise but useful answer grounded in the repository.",',
        '  "citations": [{"file":"relative/path.ext","startLine":1,"endLine":20,"why":"what this proves"}],',
        '  "mermaid": {"title":"diagram title","type":"flowchart|sequenceDiagram|classDiagram","code":"valid Mermaid diagram code"},',
        '  "scenes": [{"title":"short scene title","layout":"focus|split|evidence|diagram","emphasis":"2-7 word visual anchor","slideText":"very short on-screen text","narration":"spoken narration for this scene","visual":"what appears on screen","codeRefs":["file:1-20"]}],',
        '  "timeline": [{"label":"chapter label","seconds":10}]',
        "}",
        "",
        "Rules:",
        "- Prefer 4 to 6 scenes when the answer has multiple steps.",
        "- Each scene title must be 5 words or fewer.",
        "- Each scene layout must be one of focus, split, evidence, or diagram. Vary layouts to create visual rhythm.",
        "- Each scene emphasis must be 2 to 7 words and should name the visual anchor, not repeat the title.",
        "- Each scene slideText must be 18 words or fewer. No bullets. No markdown. No code dumps.",
        "- Each scene narration must be 35 to 55 words. It can be richer than slideText, but still concise.",
        "- Each scene visual must be 12 words or fewer.",
        "- Each scene codeRefs should include at most 2 references.",
        "- Mermaid node labels must be short: 5 words or fewer per node.",
        "- Mermaid must be valid and useful for the specific query.",
        "- Cite filenames and line ranges from the supplied chunks only.",
        "- Keep narration natural for speech.",
        "- Avoid overflowing slides by using more scenes, not more words per scene.",
        "- Treat slideText as a headline caption for a designed frame; put nuance in narration."
      ].join("\n")
    }
  ];

  let explanation;
  try {
    const response = await chatWithOllama(messages);
    const raw = extractJson(response.content);
    const citations = (Array.isArray(raw.citations) ? raw.citations : [])
      .map((citation) => normalizeCitation(citation, retrieved))
      .filter(Boolean);
    const safeCitations = citations.length ? citations : retrieved.slice(0, 5).map((chunk) => citationFromChunk(chunk));
    const mermaid = normalizeMermaid(raw.mermaid, query, retrieved);
    const warnings = [];
    let answer = clipText(raw.answer || "", 4000);
    let useGeneratedScenes = true;
    if (!answer || answerLooksWeak(answer, query)) {
      answer = createGroundedAnswer(query, retrieved);
      useGeneratedScenes = false;
      warnings.push("Gemma returned a thin answer, so CodeCinema strengthened it with retrieved code signals.");
    }
    const scenes = normalizeScenes(useGeneratedScenes ? raw.scenes : [], answer, safeCitations, mermaid);

    explanation = {
      answer,
      citations: enrichCitations(safeCitations, retrieved),
      mermaid,
      scenes,
      timeline: Array.isArray(raw.timeline) && raw.timeline.length ? raw.timeline.slice(0, 6) : createTimeline(scenes),
      narration: createNarration(scenes),
      warnings
    };
  } catch (error) {
    explanation = fallbackExplanation(query, retrieved, error);
    explanation.citations = enrichCitations(explanation.citations, retrieved);
  }

  return {
    ...explanation,
    query,
    mode,
    repo: {
      root: repo.root,
      stats: repo.stats,
      scannedAt: repo.scannedAt
    },
    retrieval: retrieved.map((chunk) => ({
      id: chunk.id,
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: chunk.score,
      language: chunk.language,
      preview: chunk.preview
    })),
    model: {
      name: model,
      host,
      provider: "ollama"
    },
    generatedAt: new Date().toISOString()
  };
}

async function generateCommitExplanation({ repoPath, commitSha, mode = "junior developer" }) {
  const commitDiff = await getCommitDiff(repoPath, commitSha);
  const chunks = chunksFromCommitDiff(commitDiff);
  const context = [
    `Commit: ${commitDiff.commit.shortSha} (${commitDiff.commit.sha})`,
    `Author: ${commitDiff.commit.author} <${commitDiff.commit.email}>`,
    `Date: ${commitDiff.commit.date}`,
    "",
    "Commit message:",
    commitDiff.commit.message || "(No commit message)",
    "",
    "Diff stat:",
    commitDiff.stat || "(No stat available)",
    "",
    "Relevant diff sections:",
    contextFromChunks(chunks)
  ].join("\n");
  const { host, model } = getOllamaConfig();
  const messages = [
    {
      role: "system",
      content: [
        STORYBOARD_SYSTEM_PROMPT,
        "For commit changelog explanations, act like a release-note author and code reviewer.",
        "Explain what changed, why it matters, likely behavior impact, and review risks without overstating unstated intent."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Audience mode: ${mode}`,
        "",
        "Commit evidence:",
        context,
        "",
        "Return ONLY valid JSON with this exact shape:",
        "{",
        '  "answer": "A concise changelog explanation grounded in the diff.",',
        '  "citations": [{"file":"relative/path.ext","startLine":1,"endLine":20,"why":"what this diff section proves"}],',
        '  "mermaid": {"title":"diagram title","type":"flowchart|sequenceDiagram","code":"valid Mermaid diagram code"},',
        '  "scenes": [{"title":"short scene title","layout":"focus|split|evidence|diagram","emphasis":"2-7 word visual anchor","slideText":"very short on-screen text","narration":"spoken narration for this scene","visual":"what appears on screen","codeRefs":["file:1-20"]}],',
        '  "timeline": [{"label":"chapter label","seconds":10}]',
        "}",
        "",
        "Rules:",
        "- Prefer 4 scenes: commit summary, changed areas, behavior impact, review notes.",
        "- Each scene title must be 5 words or fewer.",
        "- Each scene layout must be one of focus, split, evidence, or diagram. Use evidence for diff-backed claims.",
        "- Each scene emphasis must be 2 to 7 words and should name the visual anchor, not repeat the title.",
        "- Each scene slideText must be 18 words or fewer. No bullets. No markdown. No code dumps.",
        "- Each scene narration must be 35 to 55 words.",
        "- Each scene codeRefs should include at most 2 references.",
        "- Mermaid node labels must be short: 5 words or fewer per node.",
        "- Cite only files present in the diff sections.",
        "- Treat slideText as a headline caption for a designed frame; put nuance in narration."
      ].join("\n")
    }
  ];

  let explanation;
  try {
    const response = await chatWithOllama(messages);
    const raw = extractJson(response.content);
    const citations = (Array.isArray(raw.citations) ? raw.citations : [])
      .map((citation) => normalizeCitation(citation, chunks))
      .filter(Boolean);
    const safeCitations = citations.length ? citations : chunks.slice(0, 5).map((chunk) => citationFromChunk(chunk, "Changed in this commit"));
    const mermaid = normalizeMermaid(raw.mermaid, `Commit ${commitDiff.commit.shortSha}`, chunks);
    const warnings = [];
    let answer = clipText(raw.answer || "", 4000);
    let useGeneratedScenes = true;
    if (!answer || commitAnswerLooksWeak(answer, commitDiff)) {
      answer = fallbackCommitExplanation(commitDiff, chunks).answer;
      useGeneratedScenes = false;
      warnings.push("Gemma returned a thin commit summary, so CodeCinema used diff-grounded fallback notes.");
    }
    const scenes = normalizeScenes(useGeneratedScenes ? raw.scenes : [], answer, safeCitations, mermaid);

    explanation = {
      answer,
      citations: enrichCitations(safeCitations, chunks),
      mermaid,
      scenes,
      timeline: Array.isArray(raw.timeline) && raw.timeline.length ? raw.timeline.slice(0, 6) : createTimeline(scenes),
      narration: createNarration(scenes),
      warnings
    };
  } catch (error) {
    explanation = fallbackCommitExplanation(commitDiff, chunks, error);
    explanation.citations = enrichCitations(explanation.citations, chunks);
  }

  return {
    ...explanation,
    query: `Explain commit ${commitDiff.commit.shortSha}`,
    mode,
    repo: {
      root: commitDiff.root,
      stats: {
        fileCount: commitDiff.files.length,
        chunkCount: chunks.length,
        totalBytes: Buffer.byteLength(commitDiff.patch || "", "utf8"),
        skipped: 0,
        skippedLarge: 0,
        languages: { diff: chunks.length }
      },
      scannedAt: new Date().toISOString()
    },
    commit: commitDiff.commit,
    changedFiles: commitDiff.files,
    retrieval: chunks.map((chunk) => ({
      id: chunk.id,
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: chunk.score,
      language: chunk.language,
      preview: chunk.preview
    })),
    model: {
      name: model,
      host,
      provider: "ollama"
    },
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  generateCommitExplanation,
  generateExplanation
};
