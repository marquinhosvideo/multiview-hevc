# Controle negativo: merge sem as restrições de encoding

Encoder: `kvazaar --input-res 1024x576 --input-fps 30 --preset veryfast --gop lp-g4d3t1 --period 60 --no-open-gop --no-wpp --rc-algorithm lambda --bitrate 2500000 --threads 1 --level 5.1` (sem `--mv-constraint` e sem `--no-tmvp`)

| Câmera | Frames idênticos ao isolado | Primeiro frame divergente |
|---|---|---|
| cam1 | 10/600 | 1 |
| cam2 | 10/600 | 1 |
| cam3 | 10/600 | 1 |
| cam4 | 139/600 | 6 |

Sem as restrições o merge **corrompe** os quadrantes (o erro aparece onde vetores ou candidatos temporais cruzam a borda e se propaga até o próximo IDR).
