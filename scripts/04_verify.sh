#!/usr/bin/env bash
# Prova offline. Três evidências:
#   1. O arquivo merged tem UMA trilha de vídeo, com o canvas 2x2.
#   2. Decodificando o merged UMA vez, cada quadrante é idêntico, bit a bit,
#      à câmera decodificada sozinha (MD5 de todos os frames).
#   3. Custo: tempo de 1 decode do merged vs 4 decodes separados.
source "$(dirname "$0")/lib.sh"
need ffmpeg; need ffprobe

M="$BUILD/merged_2x2.hevc"
[ -f "$M" ] || die "build/merged_2x2.hevc não existe. Rode: make merge"
R="$PROOF/offline_report.md"

streams=$(ffprobe -v error -select_streams v -show_entries stream=index -of csv=p=0 "$M" | wc -l | tr -d ' ')
dims=$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=s=x:p=0 "$M")
frames=$(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$M")

{
  echo "# Prova offline: 4 câmeras, 1 bitstream, 1 decode"
  echo
  echo "Gerado em $(date '+%Y-%m-%d %H:%M:%S') em $(uname -sm)."
  echo
  echo "Encoder: \`$(cat "$BUILD/encode_params.txt" 2>/dev/null)\`"
  echo
  echo "## 1. Um único bitstream"
  echo
  echo "| Trilhas de vídeo | Resolução | Frames |"
  echo "|---|---|---|"
  echo "| $streams | $dims | $frames |"
  echo
  echo "## 2. Cada quadrante do decode único é idêntico à câmera isolada"
  echo
  echo "| Câmera | Posição | Frames | Frames idênticos | Hash da sequência (isolada) | Hash da sequência (recorte do merged) | Resultado |"
  echo "|---|---|---|---|---|---|---|"
} > "$R"

all_ok=1
for n in 1 2 3 4; do
  x=$(pos_x "$n"); y=$(pos_y "$n")
  frame_md5s "$BUILD/cam$n.hevc" > "$BUILD/.ref$n"
  frame_md5s "$M" "crop=${TILE_W}:${TILE_H}:${x}:${y}" > "$BUILD/.got$n"
  tot=$(wc -l < "$BUILD/.ref$n" | tr -d ' ')
  same=$(paste -d' ' "$BUILD/.ref$n" "$BUILD/.got$n" | awk '$1==$2' | wc -l | tr -d ' ')
  h1=$(hash_stdin < "$BUILD/.ref$n"); h2=$(hash_stdin < "$BUILD/.got$n")
  if [ "$h1" = "$h2" ]; then res="✅ bit-exact"; ok "cam$n: $same/$tot frames idênticos"
  else res="❌ diverge"; all_ok=0; warn "cam$n: só $same/$tot frames idênticos"; fi
  echo "| cam$n | ${x},${y} | $tot | $same | \`$h1\` | \`$h2\` | $res |" >> "$R"
done

# 3. Tempo de decode (CPU, software) — indicativo, não é benchmark.
t_dec() {
  local t
  t=$(ffmpeg -hide_banner -nostats -benchmark -threads 1 -i "$1" -f null - 2>&1 | sed -n 's/.*rtime=\([0-9.]*\)s.*/\1/p' | tail -1)
  echo "${t:-0}"
}
log "medindo decode (1 thread, software)..."
t_merged=$(t_dec "$M")
t_sep=0; for n in 1 2 3 4; do t_sep=$(awk "BEGIN{print $t_sep + $(t_dec "$BUILD/cam$n.hevc")}"); done
{
  echo
  echo "## 3. Custo de decode (software, 1 thread, indicativo)"
  echo
  echo "| Cenário | Instâncias de decoder | Tempo |"
  echo "|---|---|---|"
  echo "| 4 câmeras separadas | 4 | ${t_sep}s |"
  echo "| Merged 2x2 | 1 | ${t_merged}s |"
  echo
  echo "O número de pixels decodificados é o mesmo; o ganho real está em precisar de"
  echo "uma única sessão de decoder (em hardware, TVs e celulares costumam ter 1 ou 2)."
} >> "$R"

ffmpeg -v error -y -i "$M" -vf "select=eq(n\,$((FRAMES / 2))),scale=1280:-2" -frames:v 1 "$PROOF/merged_frame.png"

echo >> "$R"
if [ $all_ok -eq 1 ]; then
  echo "**Resultado: PASSOU.** Um decode do merged reconstrói as 4 câmeras sem nenhuma diferença." >> "$R"
  ok "PASSOU: 1 decode reconstruiu as 4 câmeras bit a bit. Relatório: proof/offline_report.md"
else
  echo "**Resultado: FALHOU.** Algum quadrante divergiu; ver restrições de encoding." >> "$R"
  die "FALHOU: veja proof/offline_report.md"
fi
