#!/usr/bin/env bash
# Servidor "ao vivo" local: as 4 câmeras (já codificadas) rodam em loop, em
# tempo real, e viram UM MPD DASH dinâmico com 4 AdaptationSets independentes.
# Cada câmera continua sendo um stream HEVC normal, tocável sozinho; o manifest
# só anota a posição sugerida de cada uma (SRD, urn:mpeg:dash:srd:2014).
#
# Ctrl+C para parar.
source "$(dirname "$0")/lib.sh"
need gpac

LIVE_DIR="$BUILD/live"
rm -rf "$LIVE_DIR"; mkdir -p "$LIVE_DIR"

args=(); sids=""
for n in 1 2 3 4; do
  [ -f "$BUILD/cam$n.hevc" ] || die "build/cam$n.hevc não existe. Rode: make encode"
  srd="$(pos_x "$n")x$(pos_y "$n")x${TILE_W}x${TILE_H}"
  # flist com floop=-1 repete o arquivo indefinidamente com timestamps contínuos.
  args+=("flist:srcs=$BUILD/cam$n.hevc:floop=-1:FID=s$n:#SRD=$srd:#SRDRef=${CANVAS_W}x${CANVAS_H}:#Representation=cam$n")
  sids="${sids:+$sids,}s$n"
done

URL="http://127.0.0.1:${LIVE_PORT}/live.mpd"
log "Servidor ao vivo em $URL  (segmentos de ${SEG_DUR}s, Ctrl+C para parar)"
log "Player web (Shaka): http://127.0.0.1:${LIVE_PORT}/index.html"
log "Player GPAC, em outro terminal: make live-play"

# reframer:rt=on  -> entrega os frames no ritmo do relógio (simula o ao vivo)
# dasher dynamic  -> MPD type=dynamic, segmentos numerados por tempo
# httpout         -> o próprio GPAC serve o MPD, os segmentos e a página web/
#                    (mesma origem: o Shaka não precisa de CORS)
exec gpac "${args[@]}" \
  "reframer:rt=on:SID=$sids:FID=rt" \
  -o "$URL:SID=rt:dmode=dynamic:segdur=${SEG_DUR}:profile=live:tsb=${LIVE_TSB}:template=\$Representation\$/seg_\$Number\$:rdirs=$LIVE_DIR,$ROOT/web"
