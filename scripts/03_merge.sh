#!/usr/bin/env bash
# Merge offline: 4 bitstreams HEVC -> 1 bitstream HEVC 2x2, sem decodificar nada.
# O hevcmerge do GPAC só reescreve cabeçalhos (SPS/PPS/slice header); os dados
# comprimidos de cada câmera são copiados byte a byte.
source "$(dirname "$0")/lib.sh"
need gpac

args=()
for n in 1 2 3 4; do
  [ -f "$BUILD/cam$n.hevc" ] || die "build/cam$n.hevc não existe. Rode: make encode"
  args+=(-i "$BUILD/cam$n.hevc:#CropOrigin=$(pos_x "$n")x$(pos_y "$n")")
done

out="$BUILD/merged_2x2.hevc"
log "hevcmerge -> build/merged_2x2.hevc (${CANVAS_W}x${CANVAS_H})"
# strict: aborta se SPS/PPS das câmeras não forem compatíveis.
gpac "${args[@]}" hevcmerge:mrows:strict -o "$out" 2>&1 | strip_ansi | grep -v '^[[:space:]]*$' || true
[ -s "$out" ] || die "merge não gerou saída"

# Versão em MP4 para abrir no QuickTime/Safari (1 trilha, 1 decoder).
MP4Box -quiet -add "$out:fps=$FPS" -new "$BUILD/merged_2x2.mp4" >/dev/null 2>&1 || true

in_bytes=0; for n in 1 2 3 4; do in_bytes=$(( in_bytes + $(wc -c < "$BUILD/cam$n.hevc") )); done
out_bytes=$(wc -c < "$out")
ok "merge concluído: soma das câmeras = $in_bytes bytes, merged = $out_bytes bytes (diferença = só cabeçalhos)"
ffprobe -v error -select_streams v -show_entries stream=codec_name,profile,level,width,height -of default=nw=1 "$out" | sed 's/^/    /'
