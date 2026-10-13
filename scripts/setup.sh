#!/bin/zsh
# One-time setup on an Apple Silicon Mac: ffmpeg + whisper.cpp via Homebrew, the Whisper model, and a check for Claude Code.
set -euo pipefail

MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper/ggml-large-v3-turbo-q5_0.bin}"
MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "→ installing Node.js"; brew install node
fi
for pkg in ffmpeg whisper-cpp; do
  brew list "$pkg" >/dev/null 2>&1 || { echo "→ installing $pkg"; brew install "$pkg"; }
done

if [ ! -f "$MODEL" ]; then
  echo "→ downloading Whisper large-v3-turbo (q5_0, ~550 MB)"
  mkdir -p "${MODEL:h}"
  curl -L --fail --progress-bar -o "$MODEL.part" "$MODEL_URL" && mv "$MODEL.part" "$MODEL"
fi

if command -v claude >/dev/null; then
  echo "✓ Claude Code found ($(claude --version))"
else
  echo "! Claude Code not found — install it (https://claude.com/claude-code) and sign in; chat, prep and digests use it."
fi

echo
echo "Done. Start it with:   node server.mjs        → http://localhost:4318"
echo "Or keep it running:    scripts/service.sh install"
