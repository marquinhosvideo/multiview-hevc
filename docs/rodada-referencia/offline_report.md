# Prova offline: 4 câmeras, 1 bitstream, 1 decode

Gerado em 2026-10-30 20:15:31 em Linux x86_64.

Encoder: `kvazaar --input-res 1024x576 --input-fps 30 --preset veryfast --gop lp-g4d3t1 --period 60 --no-open-gop --no-wpp --no-tmvp --mv-constraint frametilemargin --rc-algorithm lambda --bitrate 2500000 --threads 1 --level 5.1`

## 1. Um único bitstream

| Trilhas de vídeo | Resolução | Frames |
|---|---|---|
| 1 | 2048x1152 | 600 |

## 2. Cada quadrante do decode único é idêntico à câmera isolada

| Câmera | Posição | Frames | Frames idênticos | Hash da sequência (isolada) | Hash da sequência (recorte do merged) | Resultado |
|---|---|---|---|---|---|---|
| cam1 | 0,0 | 600 | 600 | `e146f02b092fa59f` | `e146f02b092fa59f` | ✅ bit-exact |
| cam2 | 1024,0 | 600 | 600 | `599bedb466b6f9ac` | `599bedb466b6f9ac` | ✅ bit-exact |
| cam3 | 0,576 | 600 | 600 | `43c55110d992795f` | `43c55110d992795f` | ✅ bit-exact |
| cam4 | 1024,576 | 600 | 600 | `1bd1f0b702d2d621` | `1bd1f0b702d2d621` | ✅ bit-exact |

## 3. Custo de decode (software, 1 thread, indicativo)

| Cenário | Instâncias de decoder | Tempo |
|---|---|---|
| 4 câmeras separadas | 4 | 6.134s |
| Merged 2x2 | 1 | 6.718s |

O número de pixels decodificados é o mesmo; o ganho real está em precisar de
uma única sessão de decoder (em hardware, TVs e celulares costumam ter 1 ou 2).

**Resultado: PASSOU.** Um decode do merged reconstrói as 4 câmeras sem nenhuma diferença.
