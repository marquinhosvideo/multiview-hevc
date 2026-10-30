#!/usr/bin/env bash
# Recodifica os 4 vídeos de inputs/ com o Kvazaar em modo "mergeável".
#
# Por que recodificar? Um HEVC qualquer não pode ser costurado em outro: os
# vetores de movimento e a predição temporal podem apontar para fora do quadro,
# e depois do merge esses pixels pertencem ao vizinho. A Tiledmedia também exige
# um perfil de encoding próprio. As restrições abaixo são o "contrato" do merge:
#
#   --mv-constraint frametilemargin  vetores de movimento ficam dentro do quadro,
#                                    com margem para o filtro de interpolação
#   --no-tmvp                        sem predição temporal de vetor (o candidato
#                                    "bottom-right" cairia no tile vizinho)
#   --no-wpp                         sem WPP; tiles + WPP juntos quebraram o
#                                    decode do merge nos testes e muitos
#                                    decoders de hardware não aceitam a combinação
#   --gop lp-g4d3t1 --period $GOP     low-delay P (ao vivo), IDR a cada GOP
#   --no-open-gop                    GOP fechado: todo segmento abre num IDR
#   --level $HEVC_LEVEL              nível do CANVAS final (o merge herda o
#                                    nível das entradas; o padrão do Kvazaar,
#                                    6.2, é rejeitado por vários decoders)
#   mesmos parâmetros nas 4 câmeras  SPS/PPS precisam ser compatíveis
source "$(dirname "$0")/lib.sh"
need ffmpeg; need kvazaar

[ $((TILE_W % 64)) -eq 0 ] && [ $((TILE_H % 64)) -eq 0 ] || die "TILE_W e TILE_H precisam ser múltiplos de 64 (atual ${TILE_W}x${TILE_H})"

THREADS=$(( $(ncpu) / 2 )); [ "$THREADS" -lt 1 ] && THREADS=1
KVZ_ARGS=(--input-res "${TILE_W}x${TILE_H}" --input-fps "$FPS"
  --preset "$KVZ_PRESET" --gop lp-g4d3t1 --period "$GOP" --no-open-gop
  --no-wpp --no-tmvp --mv-constraint frametilemargin
  --rc-algorithm lambda --bitrate "$BITRATE" --threads "$THREADS"
  --level "$HEVC_LEVEL")

echo "kvazaar ${KVZ_ARGS[*]}" > "$BUILD/encode_params.txt"
log "Encoding: $FRAMES frames/câmera ($((FRAMES / FPS)) s), tile ${TILE_W}x${TILE_H}, GOP $GOP (segmento ${SEG_DUR}s), ${BITRATE} bps"

for n in 1 2 3 4; do
  src="$(find_input "$n")" || die "inputs/cam$n.* não encontrado. Coloque seus 4 vídeos lá ou rode: make sources"
  out="$BUILD/cam$n.hevc"
  log "cam$n: $(basename "$src") -> build/cam$n.hevc"
  # Escala mantendo o aspecto (pad preto se necessário), força FPS e repete o
  # vídeo se ele for mais curto que o clipe.
  ffmpeg -v error -stream_loop -1 -i "$src" -an \
    -vf "scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p" \
    -frames:v "$FRAMES" -f rawvideo - \
  | kvazaar -i - "${KVZ_ARGS[@]}" -o "$out" 2>"$BUILD/cam$n.kvazaar.log" \
  || { tail -5 "$BUILD/cam$n.kvazaar.log"; die "kvazaar falhou em cam$n"; }
  grep -E "Processed|FPS" "$BUILD/cam$n.kvazaar.log" | sed 's/^ */    /' || true
done
ok "4 streams HEVC mergeáveis em build/"
