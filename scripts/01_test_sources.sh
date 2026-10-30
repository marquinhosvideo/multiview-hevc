#!/usr/bin/env bash
# Gera 4 vídeos HEVC sintéticos em inputs/cam1..cam4.mp4, para rodar a POC sem
# material próprio. Se você já colocou seus vídeos em inputs/, nada é sobrescrito
# (use --force para regerar).
source "$(dirname "$0")/lib.sh"
need ffmpeg

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
mkdir -p "$INPUTS"

# Codec das fontes: HEVC se disponível (como no caso real), senão H.264.
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
if grep -q " libx265 " <<<"$encoders"; then VC=(-c:v libx265 -x265-params log-level=error -crf 18 -tag:v hvc1)
elif grep -q " hevc_videotoolbox " <<<"$encoders"; then VC=(-c:v hevc_videotoolbox -b:v 8M -tag:v hvc1)
else VC=(-c:v libx264 -crf 16); warn "sem encoder HEVC no ffmpeg; fontes sintéticas em H.264 (não afeta a POC)"; fi

# Fonte para o rótulo (opcional).
FONT=""
for f in "/System/Library/Fonts/Supplemental/Arial Bold.ttf" "/System/Library/Fonts/Helvetica.ttc" \
         /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; do
  [ -f "$f" ] && { FONT="$f"; break; }
done
fflist="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
has_drawtext=0; grep -q " drawtext " <<<"$fflist" && has_drawtext=1

S="${TILE_W}x${TILE_H}"
src_for() {
  case "$1" in
    1) echo "testsrc2=s=$S:r=$FPS" ;;
    2) echo "mandelbrot=s=$S:r=$FPS" ;;
    3) echo "gradients=s=$S:r=$FPS:speed=0.03:n=5" ;;
    4) echo "smptehdbars=s=$S:r=$FPS" ;;
  esac
}

DUR=$(awk "BEGIN { printf \"%g\", $FRAMES / $FPS }")
for n in 1 2 3 4; do
  if [ $FORCE -eq 0 ] && find_input "$n" >/dev/null; then
    ok "inputs/$(basename "$(find_input "$n")") já existe, mantendo"
    continue
  fi
  rm -f "$INPUTS"/cam"$n".*
  vf="format=yuv420p"
  if [ $has_drawtext -eq 1 ]; then
    ff=""; [ -n "$FONT" ] && ff="fontfile='$FONT':"
    # Rótulo que se move na horizontal: gera movimento perto das bordas do tile,
    # exatamente onde vetores de movimento sem restrição "vazariam" para o vizinho.
    vf="drawtext=${ff}text='CAM $n':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2+((w-tw)/2)*sin(t*1.5):y=h-110,drawtext=${ff}text='%{pts\\:hms}':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6:x=w-tw-20:y=20,$vf"
  fi
  log "gerando inputs/cam$n.mp4 (${DUR}s, $S@$FPS)"
  ffmpeg -v error -y -f lavfi -i "$(src_for "$n")" -t "$DUR" -vf "$vf" "${VC[@]}" -an "$INPUTS/cam$n.mp4"
done
ok "Fontes prontas em inputs/"
