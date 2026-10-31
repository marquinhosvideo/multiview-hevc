#!/usr/bin/env bash
# Servidor HLS "ao vivo" local: as 4 câmeras (já codificadas pelo make encode) rodam
# em loop, em tempo real, e viram 4 playlists HLS independentes, como 4 encoders
# publicariam. Serve para testar o player com fonte HLS sem ter o encoder real.
#
#   HLS_FORMAT=fmp4 (padrão) ou ts   formato dos segmentos
#
# Ctrl+C para parar.
source "$(dirname "$0")/lib.sh"
need ffmpeg; need python3

FORMAT="${HLS_FORMAT:-fmp4}"
case "$FORMAT" in fmp4|ts) ;; *) die "HLS_FORMAT deve ser fmp4 ou ts" ;; esac
HLS_DIR="$BUILD/hls"
rm -rf "$HLS_DIR"; mkdir -p "$HLS_DIR"

inputs=(); maps=(); n=0
for c in 1 2 3 4; do
  [ -f "$BUILD/cam$c.hevc" ] || die "build/cam$c.hevc não existe. Rode: make encode"
  mkdir -p "$HLS_DIR/cam$c"
  inputs+=(-re -f hevc -framerate "$FPS" -stream_loop -1 -i "$BUILD/cam$c.hevc")
done

hls_args() {
  local c="$1"
  if [ "$FORMAT" = ts ]; then
    echo -map "$((c - 1)):v" -c copy -f hls -hls_segment_type mpegts -hls_segment_filename "$HLS_DIR/cam$c/seg_%d.ts"
  else
    echo -map "$((c - 1)):v" -c copy -tag:v hvc1 -f hls -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$HLS_DIR/cam$c/seg_%d.m4s"
  fi
}
outs=()
for c in 1 2 3 4; do
  # shellcheck disable=SC2046
  outs+=($(hls_args "$c") -hls_time "$SEG_DUR" -hls_list_size 10 \
    -hls_flags delete_segments+independent_segments+program_date_time+omit_endlist "$HLS_DIR/cam$c/index.m3u8")
done

python3 "$ROOT/scripts/cors_server.py" "$HLS_PORT" "$HLS_DIR" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

log "HLS ao vivo (${FORMAT}, segmentos de ${SEG_DUR}s) em http://127.0.0.1:${HLS_PORT}/camN/index.m3u8"
log "Confira:  make check-hls HLS=\"$(for c in 1 2 3 4; do printf 'http://127.0.0.1:%s/cam%s/index.m3u8 ' "$HLS_PORT" "$c"; done)\""
log "Player:   make web-hls   (em outro terminal). Ctrl+C para parar."
ffmpeg -v warning -nostdin "${inputs[@]}" "${outs[@]}"
