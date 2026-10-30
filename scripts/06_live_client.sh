#!/usr/bin/env bash
# Cliente ao vivo. Baixa as câmeras como streams DASH independentes, costura os
# bitstreams no cliente (hevcmerge) e entrega UM bitstream a UM decoder.
# É a mesma arquitetura do "single-player multiview" da Tiledmedia.
#
# Modos:
#   ./06_live_client.sh play    [segundos]  janela de vídeo (vout), 1 decoder
#   ./06_live_client.sh proof   [segundos]  sem janela: roda COM e SEM merge e
#                                            conta as instâncias de decoder
#   ./06_live_client.sh record  [segundos]  grava o bitstream mergeado (sem
#                                            decodificar) para o 08_verify_live
#
# Variáveis:
#   CAMS="1,2,3,4"   quais câmeras entram no mosaico (ex.: CAMS=1,4)
source "$(dirname "$0")/lib.sh"
need gpac

MODE="${1:-play}"
SECS="${2:-30}"
CAMS="${CAMS:-1,2,3,4}"
URL="http://127.0.0.1:${LIVE_PORT}/live.mpd"

curl -sf -o /dev/null "$URL" 2>/dev/null || die "Servidor não responde em $URL. Rode antes, em outro terminal: make live-server"

# debug_as usa índices 0-based das AdaptationSets do MPD.
AS_LIST=$(echo "$CAMS" | tr ',' '\n' | awk '{printf "%s%d", (NR>1?",":""), $1-1}')
SRC="$URL:gpac:init_timeshift=${CLIENT_DELAY_MS}:debug_as=${AS_LIST}"
RUNFOR=$(( SECS * 1000 ))

clean() { strip_ansi; }
# Linhas do grafo que são decoders (ffdec, vtbdec, ohevcdec, mcdec...).
count_decoders() { grep -E '\) [a-z0-9]+dec( |$)' | grep -vE 'dashin|dmx' | wc -l | tr -d ' '; }
decoder_names()  { grep -oE '\) [a-z0-9]+dec( |$)' | grep -vE 'dashin|dmx' | tr -d ') ' | sort | uniq -c | awk '{printf "%s x%s ", $2, $1}'; }

case "$MODE" in
  play)
    log "Tocando câmeras [$CAMS] por ${SECS}s: merge no cliente + 1 decoder (feche a janela ou espere)"
    gpac -runfor="$RUNFOR" -graph -i "$SRC" hevcmerge vout 2>&1 | clean | tee "$BUILD/live_play.log" \
      | grep -vE '^[[:space:]]*$|HTTP\] Failure|cannot be resolved|unequal duration' || true
    n=$(count_decoders < "$BUILD/live_play.log")
    echo; ok "Instâncias de decoder neste playback: $n ($(decoder_names < "$BUILD/live_play.log"))"
    ;;

  proof)
    R="$PROOF/live_decoders.md"
    log "Rodada A: SEM merge (cada câmera no seu decoder), ${SECS}s"
    gpac -runfor="$RUNFOR" -graph -i "$SRC" reframer:rt=on -o /dev/null:ext=yuv 2>&1 | clean > "$BUILD/live_nomerge.log" || true
    log "Rodada B: COM merge no cliente, ${SECS}s"
    gpac -runfor="$RUNFOR" -graph -i "$SRC" hevcmerge reframer:rt=on -o /dev/null:ext=yuv 2>&1 | clean > "$BUILD/live_merge.log" || true
    a=$(count_decoders < "$BUILD/live_nomerge.log"); b=$(count_decoders < "$BUILD/live_merge.log")
    {
      echo "# Prova ao vivo: quantos decoders o cliente abre"
      echo
      echo "Gerado em $(date '+%Y-%m-%d %H:%M:%S') em $(uname -sm). Câmeras: $CAMS. Fonte: \`$URL\`"
      echo
      echo "| Rodada | Streams baixados | Instâncias de decoder | Decoders |"
      echo "|---|---|---|---|"
      echo "| A. Sem merge | $(echo "$CAMS" | tr ',' '\n' | wc -l | tr -d ' ') | **$a** | $(decoder_names < "$BUILD/live_nomerge.log") |"
      echo "| B. Com merge (hevcmerge) | $(echo "$CAMS" | tr ',' '\n' | wc -l | tr -d ' ') | **$b** | $(decoder_names < "$BUILD/live_merge.log") |"
      echo
      echo "## Grafo da rodada B (com merge)"
      echo '```'
      sed -n '/Filters connected/,$p' "$BUILD/live_merge.log" | grep -v '^[[:space:]]*$' | head -20
      echo '```'
      echo
      echo "## Grafo da rodada A (sem merge)"
      echo '```'
      sed -n '/Filters connected/,$p' "$BUILD/live_nomerge.log" | grep -v '^[[:space:]]*$' | head -20
      echo '```'
    } > "$R"
    echo
    echo "  Sem merge: $a decoder(s)   |   Com merge: $b decoder(s)"
    if [ "$b" -eq 1 ] && [ "$a" -gt 1 ]; then ok "PASSOU: o mesmo conteúdo ao vivo usa $a decoders sem merge e 1 com merge. Relatório: proof/live_decoders.md"
    else die "Resultado inesperado (sem merge=$a, com merge=$b). Veja build/live_*.log"; fi
    ;;

  record)
    OUT="$BUILD/live_merged.hevc"; rm -f "$OUT"
    log "Gravando ${SECS}s do bitstream mergeado ao vivo em build/live_merged.hevc (sem decodificar)"
    gpac -runfor="$RUNFOR" -i "$SRC" hevcmerge reframer:rt=on -o "$OUT" 2>&1 | clean \
      | grep -vE '^[[:space:]]*$|HTTP\] Failure|cannot be resolved|unequal duration' || true
    [ -s "$OUT" ] || die "Nada gravado. O servidor está rodando?"
    ok "Gravado: $(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=s=x:p=0 "$OUT"), $(wc -c < "$OUT" | tr -d ' ') bytes. Próximo: make verify-live"
    ;;

  *) die "Modo desconhecido: $MODE (use play | proof | record)";;
esac
