SHELL := /bin/bash
S := ./scripts

.PHONY: help deps check sources encode merge verify offline control \
        live-server live-play live-proof live-record verify-live web web-test hls-server web-hls check-hls hls-test ingest open clean distclean

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
	@echo "  make web           [terminal 2] player web com Shaka: merge no navegador + 1 decoder"
	@echo "  make web-test      testa o player web sem navegador (Node): merge JS, plugin do Shaka, página"
	@echo ""
	@echo ""
	@echo "  Fonte HLS (4 streams .m3u8, por exemplo do Elemental Live):"
	@echo "  make check-hls HLS=\"url1 url2 url3 url4\"   diagnostica se os streams são mergeáveis (inclui prova bit a bit)"
	@echo "  make hls-server    [terminal 1] publica as 4 câmeras locais como HLS ao vivo (HLS_FORMAT=ts para MPEG-TS)"
	@echo "  make ingest CH=\"url1 url2 url3 url4\"   recodifica 4 canais ao vivo para o perfil mergeável (GOP igual) e publica como HLS local"
	@echo "  make web-hls       [terminal 2] abre a página de entrada HLS: cole os 4 streams, verifique e toque"
	@echo "  make hls-test      testa o caminho HLS (fMP4 e TS) sem navegador, bit a bit (precisa de Node 18+ e ffmpeg)"
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
web:         ; @$(S)/09_web.sh
web-test:    ; @$(S)/10_web_test.sh

hls-server:  ; @$(S)/11_hls_server.sh
ingest:      ; @CH="$(CH)" $(S)/12_ingest.sh
web-hls:     ; @LIVE_HLS=1 $(S)/09_web.sh
check-hls:
	@test -n "$(HLS)" || (echo 'uso: make check-hls HLS="url1 url2 url3 url4"' && exit 1)
	@command -v node >/dev/null || (echo "node não encontrado: brew install node" && exit 1)
	@node tools/check-hls.mjs $(HLS)
hls-test:
	@command -v node >/dev/null || (echo "node não encontrado: brew install node" && exit 1)
	@[ -d tools/node_modules ] || (cd tools && npm install --silent)
	@node tools/test-hls.mjs

clean:
	rm -rf build proof

distclean: clean
	find inputs -type f ! -name README.md -delete
