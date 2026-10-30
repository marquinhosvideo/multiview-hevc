SHELL := /bin/bash
S := ./scripts

.PHONY: help deps check sources encode merge verify offline control \
        live-server live-play live-proof live-record verify-live open clean distclean

help:
	@echo "POC multiview HEVC com tiles: 4 câmeras, 1 decode"
	@echo ""
	@echo "  make deps          instala (Homebrew) e valida ffmpeg, kvazaar, gpac"
	@echo "  make sources       gera 4 vídeos sintéticos em inputs/ (pula se você já pôs os seus)"
	@echo "  make offline       encode + merge + prova bit-exact (tudo offline)"
	@echo "  make control       controle negativo: mesmo fluxo SEM as restrições de encoding"
	@echo "  make open          abre o merged_2x2.mp4 no QuickTime (1 trilha, 1 decoder)"
	@echo ""
	@echo "  make live-server   [terminal 1] servidor ao vivo DASH com as 4 câmeras"
	@echo "  make live-play     [terminal 2] player: merge no cliente + 1 decoder, em janela"
	@echo "  make live-proof    [terminal 2] conta decoders COM e SEM merge (relatório)"
	@echo "  make live-record   [terminal 2] grava 20s do bitstream mergeado ao vivo"
	@echo "  make verify-live   confere a gravação bit a bit contra as fontes"
	@echo ""
	@echo "  Variáveis úteis: CAMS=1,4  BITRATE=4000000  CLIP_SECONDS=30  LIVE_PORT=8080"

deps:        ; @$(S)/00_deps.sh
check:       ; @$(S)/00_deps.sh --check
sources:     ; @$(S)/01_test_sources.sh
encode:      ; @$(S)/02_encode.sh
merge:       ; @$(S)/03_merge.sh
verify:      ; @$(S)/04_verify.sh
control:     ; @$(S)/07_negative_control.sh

offline: sources encode merge verify

open:
	@test -f build/merged_2x2.mp4 || (echo "rode make offline primeiro" && exit 1)
	@open build/merged_2x2.mp4 2>/dev/null || xdg-open build/merged_2x2.mp4

live-server: ; @$(S)/05_live_server.sh
live-play:   ; @$(S)/06_live_client.sh play 60
live-proof:  ; @$(S)/06_live_client.sh proof 15
live-record: ; @$(S)/06_live_client.sh record 20
verify-live: ; @$(S)/08_verify_live.sh

clean:
	rm -rf build proof

distclean: clean
	find inputs -type f ! -name README.md -delete
