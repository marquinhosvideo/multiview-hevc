#!/usr/bin/env bash
# Testes do player web sem navegador (precisa de Node 18+ e do servidor ao vivo):
#   1. o merge em JavaScript (web/hevc-merge.js) é bit-exact
#   2. o plugin mv:// do Shaka (web/mv-shaka.js) entrega manifesto e segmentos certos
#   3. a página (web/app.js) liga os modos, o painel e o log sem erros
source "$(dirname "$0")/lib.sh"
need node; need ffmpeg

MPD="http://127.0.0.1:${LIVE_PORT}/live.mpd"
curl -sf -o /dev/null "$MPD" 2>/dev/null || die "Servidor ao vivo não responde em $MPD. Rode antes: make live-server"
[ -d "$ROOT/tools/node_modules" ] || (cd "$ROOT/tools" && npm install --silent)

log "1/3 merge em JavaScript"
node "$ROOT/tools/test-merge.mjs" "$MPD" "$BUILD/web_merged.mp4" 5
"$ROOT/scripts/08_verify_live.sh" "$BUILD/web_merged.mp4" web_merge_report "o merge em JavaScript (web/hevc-merge.js) reconstrói as câmeras"

log "2/3 plugin mv:// do Shaka"
node "$ROOT/tools/test-shaka-glue.mjs" "$MPD" "$BUILD/shaka_glue.mp4" 4
"$ROOT/scripts/08_verify_live.sh" "$BUILD/shaka_glue.mp4" shaka_glue_report "o plugin mv:// do Shaka (web/mv-shaka.js) entrega segmentos que reconstroem as câmeras"

log "3/3 página (jsdom, Shaka simulado)"
node "$ROOT/tools/smoke-page.mjs" "$MPD"
ok "Player web validado fora do navegador. Falta só o playback real: make web"
