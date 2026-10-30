#!/usr/bin/env bash
# Verifica a gravação ao vivo (build/live_merged.hevc): decodifica UMA vez,
# recorta cada posição do canvas e confere se todos os frames recortados são
# idênticos, bit a bit, a frames da câmera original. Como o servidor roda em
# loop e o cliente entra no meio, a comparação é por pertencimento ao conjunto
# de frames da câmera (e descobre sozinha qual câmera ficou em qual posição).
#
# uso: 08_verify_live.sh [arquivo] [nome-do-relatório] [título]
#   (padrão: build/live_merged.hevc, gravado pelo cliente GPAC)
source "$(dirname "$0")/lib.sh"
need ffmpeg; need ffprobe

L="${1:-$BUILD/live_merged.hevc}"
NAME="${2:-live_report}"
TITLE="${3:-o bitstream mergeado no cliente (GPAC) reconstrói as câmeras}"
[ -s "$L" ] || die "$(basename "$L") não existe. Rode: make live-record (com o servidor ligado)"

W=$(ffprobe -v error -select_streams v -show_entries stream=width -of csv=p=0 "$L")
H=$(ffprobe -v error -select_streams v -show_entries stream=height -of csv=p=0 "$L")
cols=$(( W / TILE_W )); rows=$(( H / TILE_H ))

for n in 1 2 3 4; do frame_md5s "$BUILD/cam$n.hevc" | sort -u > "$BUILD/.set$n"; done

R="$PROOF/$NAME.md"
{
  echo "# Prova ao vivo: $TITLE"
  echo
  echo "Gerado em $(date '+%Y-%m-%d %H:%M:%S'). Gravação: ${W}x${H}, $(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$L") frames, decodificada uma única vez."
  echo
  echo "| Posição no canvas | Câmera identificada | Frames idênticos à fonte | Resultado |"
  echo "|---|---|---|---|"
} > "$R"

all_ok=1
for r in $(seq 0 $((rows - 1))); do
  for c in $(seq 0 $((cols - 1))); do
    x=$(( c * TILE_W )); y=$(( r * TILE_H ))
    frame_md5s "$L" "crop=${TILE_W}:${TILE_H}:${x}:${y}" > "$BUILD/.live_tile"
    tot=$(wc -l < "$BUILD/.live_tile" | tr -d ' ')
    best=0; bestn="?"
    for n in 1 2 3 4; do
      m=$(grep -cFxf "$BUILD/.set$n" "$BUILD/.live_tile" || true)
      [ "$m" -gt "$best" ] && { best=$m; bestn=$n; }
    done
    if [ "$best" -eq "$tot" ] && [ "$tot" -gt 0 ]; then res="✅ bit-exact"; ok "posição ${x},${y} = cam$bestn: $best/$tot frames idênticos"
    else res="❌"; all_ok=0; warn "posição ${x},${y}: melhor = cam$bestn com $best/$tot"; fi
    echo "| ${x},${y} | cam$bestn | $best/$tot | $res |" >> "$R"
  done
done

ffmpeg -v error -y -i "$L" -vf "select=eq(n\,60),scale=1280:-2" -frames:v 1 "$PROOF/${NAME%_report}_frame.png" || true
echo >> "$R"
if [ $all_ok -eq 1 ]; then
  echo "**Resultado: PASSOU.** Todos os frames de todas as posições batem bit a bit com a câmera de origem." >> "$R"
  ok "PASSOU. Relatório: proof/$NAME.md"
else
  echo "**Resultado: FALHOU.**" >> "$R"; die "FALHOU: veja proof/$NAME.md"
fi
