#!/usr/bin/env bash
# Instala (macOS/Homebrew) e valida as ferramentas da POC.
#   ./scripts/00_deps.sh           -> instala o que faltar e valida
#   ./scripts/00_deps.sh --check   -> só valida
source "$(dirname "$0")/lib.sh"

if [ "${1:-}" != "--check" ] && [ "$(uname -s)" = "Darwin" ]; then
  command -v brew >/dev/null 2>&1 || die "Homebrew não encontrado. Instale em https://brew.sh e rode de novo."
  for pkg in ffmpeg gpac kvazaar; do
    if brew list --formula "$pkg" >/dev/null 2>&1; then ok "$pkg já instalado"
    else log "brew install $pkg"; brew install "$pkg"; fi
  done
fi

for b in ffmpeg ffprobe kvazaar gpac MP4Box; do need "$b"; done

echo
log "Versões"
echo "  ffmpeg : $(ffmpeg -version | head -1 | awk '{print $3}')"
echo "  kvazaar: $(kvazaar --version 2>&1 | head -1)"
echo "  gpac   : $(gpac -version 2>&1 | strip_ansi | grep -m1 -o 'version [^ ]*')"
echo

fail=0
filters="$(gpac -h filters 2>&1 | strip_ansi)"
for f in hevcmerge dashin dasher httpout reframer flist; do
  if grep -q "^$f:" <<<"$filters"; then ok "gpac filtro '$f'"; else warn "gpac sem filtro '$f'"; fail=1; fi
done

kh="$(kvazaar --help 2>&1)"
for opt in mv-constraint no-tmvp no-wpp rc-algorithm; do
  if grep -q -- "$opt\|(no-)${opt#no-}" <<<"$kh"; then ok "kvazaar opção --$opt"; else warn "kvazaar sem --$opt"; fail=1; fi
done

if [ "$(uname -s)" = "Darwin" ]; then
  if grep -q "^vtbdec:" <<<"$filters"; then ok "gpac com VideoToolbox (vtbdec): decode HEVC em hardware"
  else warn "gpac sem vtbdec: o decode vai cair em software (ffdec). A prova continua válida."; fi
fi

fflist="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
if grep -q " drawtext " <<<"$fflist"; then ok "ffmpeg com drawtext (rótulos CAM 1..4 nas fontes sintéticas)"
else warn "ffmpeg sem drawtext: as fontes sintéticas sairão sem rótulo"; fi

echo
[ $fail -eq 0 ] && ok "Ambiente pronto." || die "Ambiente incompleto (veja os avisos acima)."
