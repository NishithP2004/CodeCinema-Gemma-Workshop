# CodeCinema

CodeCinema is a local-first repo explainer that turns a codebase question into a cited walkthrough, Mermaid diagram, narration script, and MP4 storyboard.

## What It Does

- Scans a local repository and chunks source files.
- Retrieves relevant code for a user query.
- Uses Ollama with `gemma4:e2b` to generate a grounded explanation, citations, Mermaid, and a video scene plan.
- Renders storyboard slides, local TTS narration, and an MP4 with ffmpeg.
- Exports `storyboard.json`, `diagram.mmd`, narration text/audio, slides, and the final video.

## Run

```bash
npm run dev
```

Then open:

```text
http://localhost:5177
```

The default environment is already in `.env`:

```env
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:e2b
```

You can override it per run:

```bash
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=gemma4:e2b npm run dev
```

## Local TTS

CodeCinema uses provider detection:

1. `TTS_COMMAND` if configured.
2. Piper if `PIPER_MODEL` is configured and `piper` is installed.
3. macOS `say` as a local fallback.

For Piper:

```env
TTS_PROVIDER=piper
PIPER_MODEL=/absolute/path/to/voice.onnx
```

For Kokoro or another local command:

```env
TTS_PROVIDER=command
TTS_COMMAND=/path/to/tts-wrapper
```

The command receives:

```text
CODECINEMA_TTS_INPUT
CODECINEMA_TTS_OUTPUT
```

## Mermaid Chart

The app always generates Mermaid source and previews it in the browser when Mermaid JS can load. To sync through Mermaid Chart or a compatible internal endpoint, set:

```env
MERMAID_CHART_API_URL=
MERMAID_CHART_API_KEY=
```

The adapter posts:

```json
{
  "title": "Diagram title",
  "diagram": "flowchart TD..."
}
```

## MVP Flow

1. Enter a local repo path.
2. Or use **Choose Folder** to select a repo in the browser without typing the full path.
3. Ask a question like `Explain authentication flow`.
4. Generate the explainer.
5. Render the video.
6. Open the generated MP4 or exported assets from the Output panel.

Browser folder selection sends readable source files to the local CodeCinema server with relative paths only. Browsers do not expose the absolute folder path, so the typed path mode is still available when server-side path scanning is preferred.
