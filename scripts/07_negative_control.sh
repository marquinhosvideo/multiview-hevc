#!/usr/bin/env bash
# Controle negativo: repete o encode SEM as restrições (MV livre, TMVP ligado)
# e mostra que o merge passa a corromper os quadrantes. Serve para provar que o
# resultado bit-exact vem das restrições de encoding, e não de sorte.
source "$(dirname "$0")/lib.sh"
need ffmpeg; need kvazaar; need gpac

C="$BUILD/control"; mkdir -p "$C"
THREADS=$(( $(ncpu) / 2 )); [ "$THREADS" -lt 1 ] && THREADS=1
# Mesmos parâmetros do 02_encode.sh, exceto: sem --mv-constraint e sem --no-tmvp.
# (--no-wpp fica, para isolar o efeito de MV/TMVP.)
KVZ_ARGS=(--input-res "${TILE_W}x${TILE_H}" --input-fps "$FPS"
  --preset "$KVZ_PRESET" --gop lp-g4d3t1 --period "$GOP" --no-open-gop --no-wpp
  --rc-algorithm lambda --bitrate "$BITRATE" --threads "$THREADS" --level "$HEVC_LEVEL")

args=()
for n in 1 2 3 4; do
  src="$(find_input "$n")" || die "inputs/cam$n.* não encontrado"
  log "cam$n sem restrições"
  ffmpeg -v error -stream_loop -1 -i "$src" -an \
    -vf "scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p" \
    -frames:v "$FRAMES" -f rawvideo - | kvazaar -i - "${KVZ_ARGS[@]}" -o "$C/cam$n.hevc" 2>/dev/null
  args+=(-i "$C/cam$n.hevc:#CropOrigin=$(pos_x "$n")x$(pos_y "$n")")
done
gpac "${args[@]}" hevcmerge:mrows -o "$C/merged_2x2.hevc" >/dev/null 2>&1 || true

R="$PROOF/negative_control.md"
{
  echo "# Controle negativo: merge sem as restrições de encoding"
  echo
  echo "Encoder: \`kvazaar ${KVZ_ARGS[*]}\` (sem \`--mv-constraint\` e sem \`--no-tmvp\`)"
  echo
  echo "| Câmera | Frames idênticos ao isolado | Primeiro frame divergente |"
  echo "|---|---|---|"
} > "$R"
any_bad=0
for n in 1 2 3 4; do
  frame_md5s "$C/cam$n.hevc" > "$C/.ref$n"
  frame_md5s "$C/merged_2x2.hevc" "crop=${TILE_W}:${TILE_H}:$(pos_x "$n"):$(pos_y "$n")" > "$C/.got$n" 2>/dev/null || true
  tot=$(wc -l < "$C/.ref$n" | tr -d ' ')
  same=$(paste -d' ' "$C/.ref$n" "$C/.got$n" | awk '$1==$2' | wc -l | tr -d ' ')
  first=$(paste -d' ' "$C/.ref$n" "$C/.got$n" | awk '$1!=$2 {print NR-1; exit}')
  [ "$same" -lt "$tot" ] && any_bad=1
  echo "| cam$n | $same/$tot | ${first:--} |" >> "$R"
  echo "  cam$n: $same/$tot idênticos (primeiro divergente: ${first:--})"
done
echo >> "$R"
if [ $any_bad -eq 1 ]; then
  echo "Sem as restrições o merge **corrompe** os quadrantes (o erro aparece onde vetores ou candidatos temporais cruzam a borda e se propaga até o próximo IDR)." >> "$R"
  ok "Controle negativo confirmou: sem as restrições, o merge diverge. Relatório: proof/negative_control.md"
else
  echo "Neste conteúdo nenhuma divergência apareceu; isso não prova que as restrições sejam dispensáveis (depende do movimento perto das bordas)." >> "$R"
  warn "Neste conteúdo o controle negativo não divergiu (depende do movimento perto das bordas)."
fi
