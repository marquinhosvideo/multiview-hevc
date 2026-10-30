# Aprendizados: o que precisa ser verdade para o merge funcionar

Cada item abaixo apareceu durante a construção da POC, com a evidência que
levou à decisão. A lista é o "contrato de encoding" que um encoder de produção
(Elemental, MediaKind, Harmonic, Ateme...) teria que cumprir para alimentar um
player com merge de tiles.

## 1. Vetores de movimento dentro do quadro (`--mv-constraint frametilemargin`)

Num stream isolado, um vetor de movimento que aponta para fora da borda lê
pixels "esticados" da própria borda. Depois do merge, a mesma posição é o tile
vizinho, então a predição muda e o erro se propaga até o próximo IDR.

O `frametilemargin` mantém os vetores dentro do quadro com uma margem para os
filtros de interpolação de subpixel (8 taps em luma).

**Evidência:** controle negativo (`make control`) sem esta restrição e sem o
item 2: só 10, 10, 13 e 139 de 600 frames ficaram idênticos.

## 2. TMVP desligado (`--no-tmvp`)

Este foi o achado menos óbvio. Com `--mv-constraint` ligado mas TMVP ligado, a
cam1 (canto superior esquerdo) divergia **só nos frames 5 a 59**, e as demais
batiam.

Explicação: o candidato temporal "bottom-right" de uma PU na borda direita do
tile cai fora do quadro no stream isolado (candidato indisponível), mas cai
dentro do tile vizinho no canvas mergeado (candidato disponível). A lista de
candidatos de merge muda, e com ela o vetor decodificado. As câmeras da coluna
da direita não sofrem porque ali continua sendo a borda do canvas. Depois do
IDR do frame 60 tudo volta a bater.

Custo: alguma perda de eficiência de compressão (não medida aqui). Alternativa
a investigar em encoders de produção: em vez de desligar o TMVP inteiro,
bloquear só os candidatos temporais que cruzam a borda.

## 3. WPP desligado (`--no-wpp`)

Com WPP (`entropy_coding_sync`) e controle de taxa por lambda (`cu_qp_delta`
ativo), o merge com tiles **lado a lado** gerava erros de CABAC no decode
(`cu_qp_delta outside the valid range`). Empilhados verticalmente, não. Com QP
constante, também não.

Não isolei se é limitação do decoder do FFmpeg com tiles + WPP ou do merge.
Como a combinação tiles + WPP é rara e vários decoders de hardware não a
aceitam, a decisão prática foi desligar o WPP. Vale reabrir se o encoder de
produção depender de WPP para paralelismo.

## 4. Dimensões em múltiplos de 64

O `hevcmerge` só aceita tiles fora da última linha/coluna com largura e altura
múltiplas do CTU máximo (64). Por isso 1024x576 por câmera (16:9 exato) e não
960x540.

## 5. Nível HEVC do canvas, não do tile

O merge herda o nível das entradas. O Kvazaar sinaliza 6.2 por padrão, e um
decoder de hardware que só suporta até 5.1 pode recusar o stream mesmo que o
conteúdo real seja pequeno. Cada câmera é encodada com o nível que o **canvas**
precisa: 2048x1152@30 cabe em 5.1 (cabe até em 5.0). Um canvas 4K@30 também
cabe em 5.0/5.1.

## 6. Mesmos parâmetros em todas as câmeras

SPS/PPS precisam ser compatíveis: mesmo encoder, mesmo preset, mesmo GOP, mesmo
`init_qp`. O `03_merge.sh` usa `hevcmerge:strict`, que aborta se não forem.

## 7. GOP = segmento, e clipe múltiplo do GOP

O primeiro teste ao vivo usava clipes de 150 frames com IDR a cada 60. No loop,
o IDR do frame 150 caía no meio de um segmento, o dasher atrasava o corte e o
cliente pedia segmentos que ainda não existiam (HTTP 404 constante).

Regra: segmento = GOP / FPS (aqui 60/30 = 2 s), GOP fechado, e a duração de
cada clipe arredondada para um múltiplo do GOP (`lib.sh` faz isso).

Em produção, com encoder ao vivo de verdade, o equivalente é **IDR alinhado
entre todas as câmeras** (mesmo relógio, mesmo GOP). Sem isso o cliente não
consegue costurar frames do mesmo instante.

## 8. Cliente atrás do live edge

O cliente DASH do GPAC, por padrão, pede o segmento que contém "agora", que no
servidor ainda está sendo produzido. Com `init_timeshift=6000` ele entra 6 s
atrás e os 404 somem. Num player real isso é a latência alvo (o mesmo ajuste de
`liveDelay` do dash.js ou do Shaka).

## 9. A ordem no canvas é do merge, o layout é do render

Com uma única sessão DASH, o `hevcmerge` dispõe os tiles em ordem de coluna
(cam1, cam2 na primeira coluna; cam3, cam4 na segunda). O `08_verify_live.sh`
descobre sozinho qual câmera está em cada posição. A posição no canvas não
importa: quem decide onde cada câmera aparece na tela é o renderizador, depois
do decode, usando o mapa de tiles.

## 10. Versão do GPAC importa

O GPAC 2.2 do Ubuntu fez o merge offline, mas o cliente ao vivo caiu
(segfault / `malloc(): invalid size`). Com o GPAC atual do GitHub (26.08-DEV,
mesma linha do Homebrew 26.07) tudo funcionou. Use a versão do Homebrew.
