#!/usr/bin/env bash
# Recodifica 4 canais ao vivo (HLS ou DASH) para o perfil "mergeável" e os publica como HLS local.
#
# Por que: canais de TV têm GOP, resolução, WPP, TMVP e vetores de movimento próprios, e o merge de tiles
# exige o contrato de scripts/02_encode.sh nos 4 canais. Isso não se conserta editando o vídeo (a estrutura de
# GOP está nas referências entre quadros); só recodificando. Aqui cada canal é decodificado, reduzido para
# TILE_W x TILE_H, convertido para FPS e recodificado com GOP fixo e fechado, em segmentos de SEG_DUR s, sem
# TMVP/WPP e (com o Kvazaar) com vetores de movimento dentro do quadro.
#
#   make ingest CH="https://.../canal1.m3u8 https://.../canal2.m3u8 https://.../canal3.m3u8 https://.../canal4.m3u8"
#   saída:  http://127.0.0.1:$HLS_PORT/ch1..ch4/index.m3u8   (cole na página, ou use o botão "canais recodificados")
#
#   INGEST_ENCODER=auto|kvazaar|x265   (auto: Kvazaar se instalado; o x265 NÃO restringe os vetores de movimento,
#                                       então pode haver artefatos junto às bordas dos tiles)
#   INGEST_ONCE=1                       não reinicia o canal quando a entrada acaba (útil em teste)
#
# O custo é CPU: 4 decodes + 4 encodes em tempo real. Ctrl+C para parar.
source "$(dirname "$0")/lib.sh"
need ffmpeg; need python3

URLS=("$@")
[ ${#URLS[@]} -eq 0 ] && read -r -a URLS <<<"${CH:-}"
[ ${#URLS[@]} -eq 4 ] || die 'uso: make ingest CH="url1 url2 url3 url4"  (4 canais)'
[ $((TILE_W % 64)) -eq 0 ] && [ $((TILE_H % 64)) -eq 0 ] || die "TILE_W e TILE_H precisam ser múltiplos de 64 (atual ${TILE_W}x${TILE_H})"

ENC="${INGEST_ENCODER:-auto}"
if [ "$ENC" = auto ]; then command -v kvazaar >/dev/null 2>&1 && ENC=kvazaar || ENC=x265; fi
case "$ENC" in
  kvazaar) need kvazaar ;;
  x265) encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"   # variável: com pipefail, grep -q + pipe dá SIGPIPE
        grep -q libx265 <<<"$encoders" || die "ffmpeg sem libx265 (brew reinstall ffmpeg)"
        warn "usando x265: ele não restringe os vetores de movimento; para a prova bit a bit, instale o Kvazaar (make deps)" ;;
  *) die "INGEST_ENCODER deve ser auto, kvazaar ou x265" ;;
esac

OUT="$BUILD/ingest"; rm -rf "$OUT"; mkdir -p "$OUT"
THREADS=$(( $(ncpu) / 4 )); [ "$THREADS" -lt 1 ] && THREADS=1
VF="scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv"
HLS=(-f hls -hls_time "$SEG_DUR" -hls_list_size 10 -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4
     -hls_flags delete_segments+independent_segments+program_date_time+omit_endlist)
IN=(-loglevel warning -nostdin -rw_timeout 20000000)

channel() {
  local n="$1" url="$2" d="$OUT/ch$1"
  mkdir -p "$d"
  if [ "$ENC" = kvazaar ]; then
    # Mantenha igual ao contrato de scripts/02_encode.sh.
    ffmpeg "${IN[@]}" -i "$url" -an -vf "$VF" -f rawvideo - \
    | kvazaar -i - --input-res "${TILE_W}x${TILE_H}" --input-fps "$FPS" --preset "$KVZ_PRESET" --gop lp-g4d3t1 --period "$GOP" --no-open-gop \
        --no-wpp --no-tmvp --mv-constraint frametilemargin --rc-algorithm lambda --bitrate "$BITRATE" --threads "$THREADS" --level "$HEVC_LEVEL" -o - 2>"$d/kvazaar.log" \
    | ffmpeg -loglevel warning -nostdin -f hevc -framerate "$FPS" -i - -c copy -tag:v hvc1 "${HLS[@]}" -hls_segment_filename "$d/seg_%d.m4s" "$d/index.m3u8"
  else
    ffmpeg "${IN[@]}" -i "$url" -an -vf "$VF" -c:v libx265 -preset "${INGEST_X265_PRESET:-ultrafast}" -b:v "$BITRATE" -maxrate "$BITRATE" -bufsize "$((BITRATE * 2))" -tag:v hvc1 \
      -x265-params "keyint=${GOP}:min-keyint=${GOP}:open-gop=0:scenecut=0:bframes=0:b-adapt=0:ref=1:weightp=0:slices=1:no-wpp=1:temporal-mvp=0:repeat-headers=1:aud=0:level-idc=${HEVC_LEVEL//./}:log-level=error" \
      "${HLS[@]}" -hls_segment_filename "$d/seg_%d.m4s" "$d/index.m3u8"
  fi
}

run_forever() {
  local n="$1" url="$2"
  while true; do
    channel "$n" "$url" || warn "canal $n: o encode terminou com erro"
    [ -n "${INGEST_ONCE:-}" ] && break
    warn "canal $n: entrada interrompida; reiniciando em 3 s"; sleep 3
  done
}

python3 "$ROOT/scripts/cors_server.py" "$HLS_PORT" "$OUT" &
SERVER=$!
PIDS=("$SERVER")
trap 'kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null' EXIT INT TERM
for i in 0 1 2 3; do run_forever "$((i + 1))" "${URLS[$i]}" & PIDS+=($!); done

log "Ingest ($ENC): 4 canais -> HLS ${TILE_W}x${TILE_H}@${FPS}, GOP ${GOP} (segmentos de ${SEG_DUR}s)"
log "Canais recodificados em http://127.0.0.1:${HLS_PORT}/ch1..ch4/index.m3u8"
log "Página: make web-hls (botão \"Usar os canais recodificados\"). Ctrl+C para parar."
wait "${PIDS[@]:1}"
