#!/usr/bin/env bash
# Funções compartilhadas. Compatível com o bash 3.2 do macOS (sem arrays
# associativos, sem `timeout`, sem `date -d`, sem `md5sum` obrigatório).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/config.env"

INPUTS="$ROOT/inputs"
BUILD="$ROOT/build"
PROOF="$ROOT/proof"
mkdir -p "$BUILD" "$PROOF"

# Frames por clipe, arredondado para baixo a um múltiplo do GOP (mínimo 1 GOP).
FRAMES=$(( (CLIP_SECONDS * FPS) / GOP * GOP ))
[ "$FRAMES" -lt "$GOP" ] && FRAMES=$GOP
SEG_DUR=$(awk "BEGIN { printf \"%g\", $GOP / $FPS }")

# Canvas 2x2 e posição (x,y) de cada câmera no canvas.
CANVAS_W=$(( TILE_W * 2 ))
CANVAS_H=$(( TILE_H * 2 ))
pos_x() { case "$1" in 1|3) echo 0;; *) echo "$TILE_W";; esac; }
pos_y() { case "$1" in 1|2) echo 0;; *) echo "$TILE_H";; esac; }

c_green=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { echo "${c_dim}[$(date +%H:%M:%S)]${c_off} $*"; }
ok()   { echo "${c_green}✔${c_off} $*"; }
warn() { echo "${c_yel}!${c_off} $*"; }
die()  { echo "${c_red}✘ $*${c_off}" >&2; exit 1; }

ncpu() { sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4; }

# Remove cores ANSI da saída do GPAC. Usa o caractere ESC literal porque o sed
# do macOS (BSD) não entende a sequência \x1b.
ESC=$'\033'
strip_ansi() { sed "s/${ESC}\[[0-9;]*m//g"; }

# Hash de stdin (md5sum no Linux, md5 no macOS).
hash_stdin() {
  if command -v md5sum >/dev/null 2>&1; then md5sum | cut -c1-16
  else md5 -q | cut -c1-16; fi
}

# Lista os MD5 de cada frame decodificado (um por linha), com filtro opcional.
# uso: frame_md5s <arquivo> [filtro_de_video]
frame_md5s() {
  local f="$1" vf="${2:-}"
  if [ -n "$vf" ]; then
    ffmpeg -v error -i "$f" -vf "$vf" -f framemd5 - | grep -v '^#' | awk -F, '{gsub(/ /,"",$6); print $6}'
  else
    ffmpeg -v error -i "$f" -f framemd5 - | grep -v '^#' | awk -F, '{gsub(/ /,"",$6); print $6}'
  fi
}

# Localiza o vídeo de entrada camN.<qualquer extensão> em inputs/.
find_input() {
  local n="$1" f
  for f in "$INPUTS"/cam"$n".*; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' não encontrado. Rode: make deps"; }
