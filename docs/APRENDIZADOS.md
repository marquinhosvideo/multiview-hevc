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


## HLS como fonte (aprendido ao implementar)

- **SPS e PPS precisam ser byte a byte iguais entre as câmeras.** Até o VUI
  conta: quatro fontes que diferiam só na sinalização de cor (BT.709 vs não
  especificado) geraram SPS diferentes e o merge recusou. Em encoders reais,
  configure a mesma colorimetria, nível e perfil em todos.
- **Pareamento por `EXT-X-PROGRAM-DATE-TIME`, não por número de sequência.**
  Encoders independentes numeram os segmentos de forma diferente. Sem PDT, o
  player só pareia por sequência, e o diagnóstico avisa.
- **O `tfdt` dos segmentos precisa coincidir entre câmeras.** O merge recusa
  câmeras cujo relógio de mídia (PTS) está deslocado, com mensagem clara. Se os
  seus encoders começam o PTS em origens diferentes, é preciso sincronizá-los
  (relógio/timecode comum) ou normalizar o `tfdt` no cliente (não implementado).
- **MPEG-TS funciona**, remuxado para fMP4 no cliente: copia os slices e
  reescreve só a embalagem. Testado, bit a bit, com B-frames (DTS diferente de
  PTS). Limites: 1 programa, sem criptografia, sem tratar a virada de 33 bits do PTS.
- **O diagnóstico é a prova.** Ler o SPS (TMVP) é barato, mas não revela os
  vetores de movimento. Só decodificar e comparar cada tile com a câmera isolada
  mostra se o encoder respeita as bordas: com TMVP ligado, as câmeras do
  topo/esquerda divergiram desde o 2º quadro e a do canto inferior direito
  passou 100%, o mesmo padrão do item 2.
- **Canais independentes (multiview de TV).** Sem relógio comum, o pareamento é por
  posição: o segmento mais recente de cada canal (VOD: o primeiro), com offsets de
  sequência fixados na primeira leitura. O merge ignora o `tfdt` de cada canal e usa
  o tempo do canal 1. O que **não** pode diferir: contagem de quadros por segmento
  (taxa de quadros e GOP), SPS/PPS e resolução. Em canais reais, a estrutura de GOP
  também tem de ser a mesma quadro a quadro (tipo de slice, POC, RPS), o que GOP
  adaptativo ou scenecut quebra. Isso só se confirma decodificando
  (`make check-hls`). Limite conhecido: canais com taxas de segmento ligeiramente
  diferentes (29,97 vs 30) deslizam um contra o outro ao longo de horas; a pareação
  por contagem não se reancora sozinha.
- **DASH como fonte.** `web/dash.js` lê o MPD de um canal e devolve a mesma estrutura de
  uma playlist HLS (segmentos, init, duração, PDT derivado do `availabilityStartTime`), então
  o pareamento e o merge não mudam. Os números de sequência são consecutivos e estáveis
  entre atualizações do MPD (mapa `t -> seq` mantido por canal).
- **WPP nos canais (atualização do item 3).** O merge agora aceita câmeras com WPP: mantém
  o `entropy_coding_sync` e copia os entry points do slice header (cada câmera vira um slice
  que ocupa um tile inteiro, com as mesmas linhas de CTU). Mas tiles **lado a lado** + WPP
  dão `cu_qp_delta outside the valid range` no FFmpeg (a sincronização das linhas assume a
  largura do quadro), então, com WPP, o canvas empilha os tiles em **1 coluna** (ex.: 4 canais
  1024x576 -> 1024x2304). Testado: 180/180 quadros idênticos no FFmpeg. Os layouts da página só
  recortam o frame, então a disposição não muda nada para quem assiste. Não testado: decoders de
  hardware, que podem recusar tiles + WPP no mesmo stream; se for o caso, desligue o WPP no
  encoder (`--no-wpp`).
- **Predição ponderada (weighted prediction).** Aceita: o `pred_weight_table()` do slice header
  é lido só para achar o fim do cabeçalho, e os bits são copiados como estão (os pesos valem por
  slice e cada câmera é o seu slice). Validado comparando, com o `trace_headers` do FFmpeg, todos
  os elementos do slice header da câmera isolada e do seu slice no merge (P e B, com pesos
  reais). Isso prova o cabeçalho, não os pixels: com x265 os vetores podem cruzar a borda do
  tile, então a prova de pixels continua sendo `make check-hls` com um encode restrito.
- **Resolução, CTU e canvas (canais de TV).** Tile não precisa ter largura *e* altura múltiplas do
  CTU: só os limites *entre* tiles caem em fronteira de CTU (a última coluna/linha pode ser
  parcial). Com largura múltipla e altura não (1080p, 540p, 2160p com CTU 64) o merge usa 1
  fileira de tiles; com WPP, 1 coluna (e aí a altura tem de ser múltipla). O canvas passa a
  somar tudo: 4 canais 4K = 15360x2160, inviável; 4 x 960x540 = 3840x544 e 4 x 1920x1080 =
  7680x1080 passaram bit a bit no FFmpeg (fontes só intra). O `general_level_idc` do canvas (SPS,
  VPS e hvcC) é elevado ao necessário para o tamanho; a taxa de amostras (MaxLumaSr, depende
  do fps) não é verificada. Decoders de hardware podem recusar o que o FFmpeg aceita.
