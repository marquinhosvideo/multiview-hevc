#!/usr/bin/env bash
# Serve a página do player (web/) e abre no navegador. Com LIVE_HLS=1 (make web-hls)
# abre a página de entrada HLS (hls.html). O servidor também tem um proxy local
# (/proxy?url=...) para HLS de origens sem CORS.
# O vídeo vem do servidor ao vivo (make live-server, porta LIVE_PORT); a página
# fica num servidor estático separado (porta WEB_PORT) porque o servidor HTTP do
# GPAC não envia Content-Type para .html. O GPAC responde com CORS, então o
# Shaka busca MPD e segmentos dele normalmente.
source "$(dirname "$0")/lib.sh"
command -v python3 >/dev/null 2>&1 || die "python3 não encontrado (vem com as Command Line Tools do Xcode: xcode-select --install)"

WEB_PORT="${WEB_PORT:-8081}"
MPD="http://127.0.0.1:${LIVE_PORT}/live.mpd"
URL="http://127.0.0.1:${WEB_PORT}/index.html?mpd=$MPD"
if [ -n "${LIVE_HLS:-}" ]; then
  # Entrada HLS: página para colar as 4 URLs (o proxy local contorna o CORS).
  URL="http://127.0.0.1:${WEB_PORT}/hls.html"
  MPD="http://127.0.0.1:${HLS_PORT}/cam1/index.m3u8"
fi

if [ -z "${LIVE_HLS:-}" ]; then
  curl -sf -o /dev/null "$MPD" 2>/dev/null || warn "O servidor ao vivo não responde em $MPD. Rode antes, em outro terminal: make live-server"
fi

log "Página do player: $URL"
log "Use Safari ou Chrome (HEVC via MSE). Ctrl+C para parar."
( sleep 1; open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true ) &
exec python3 "$ROOT/scripts/web_server.py" "$WEB_PORT" "$ROOT/web"
