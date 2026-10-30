# inputs/

Coloque aqui os 4 vídeos de entrada com os nomes `cam1`, `cam2`, `cam3` e `cam4`
(qualquer extensão que o ffmpeg leia: `cam1.mp4`, `cam2.mov`, `cam3.ts`...).

- Não precisam ser HEVC nem ter a mesma resolução: o `make encode` recodifica
  tudo com o Kvazaar no perfil "mergeável" (ver `scripts/02_encode.sh`).
- Se forem mais curtos que `CLIP_SECONDS` (padrão 20 s), são repetidos em loop.
- Sem vídeos aqui, `make sources` gera 4 fontes sintéticas.

Os arquivos desta pasta não vão para o git (ver `.gitignore`).
