# POC: multiview HEVC com tiles, 4 câmeras e 1 decode

Prova de conceito, 100% open source, da técnica usada pela Tiledmedia no
"single-player multiview": o player baixa várias câmeras como streams HEVC
independentes, **costura os bitstreams comprimidos num único bitstream HEVC com
tiles** e entrega isso a **um único decoder**. Nada é transcodificado: só os
cabeçalhos (SPS/PPS/slice header) são reescritos.

Ferramentas: [Kvazaar](https://github.com/ultravideo/kvazaar) (encoder HEVC com
vetores de movimento restritos) e [GPAC](https://github.com/gpac/gpac)
(empacotamento DASH, servidor HTTP, cliente DASH e o filtro `hevcmerge`).

## O que a POC prova

| # | Pergunta | Como é provado | Comando |
|---|---|---|---|
| 1 | Dá para juntar 4 HEVC num só, sem decodificar? | O merge gera 1 trilha 2048x1152 cujo tamanho é a soma das câmeras menos cabeçalhos | `make offline` |
| 2 | O resultado é idêntico ao original? | Decodificando o merged **uma vez**, cada quadrante bate **bit a bit** (MD5 de todos os frames) com a câmera decodificada sozinha | `make offline` |
| 3 | As restrições de encoding são necessárias? | Controle negativo: sem elas, só 10 a 139 de 600 frames sobrevivem ao merge | `make control` |
| 4 | Funciona ao vivo, com o merge no cliente? | Servidor DASH ao vivo + cliente que conta instâncias de decoder: **4 sem merge, 1 com merge** | `make live-proof` |
| 5 | O que o cliente ao vivo decodifica está correto? | Gravação do bitstream mergeado ao vivo, conferida bit a bit contra as fontes | `make live-record verify-live` |
| 6 | Funciona num player web de mercado? | **Shaka Player** numa página local: o merge roda em JavaScript dentro do navegador e o Shaka entrega 1 stream a 1 `SourceBuffer` | `make web` / `make web-test` |

Os relatórios ficam em `proof/` (Markdown + PNG).

## Arquitetura

```
        ENCODE (uma vez)                 SERVIDOR AO VIVO (GPAC)                  CLIENTE (GPAC)
                                                                       
 inputs/cam1 ─► Kvazaar ─► cam1.hevc ─┐                               ┌─ AS1 (cam1) ─┐
 inputs/cam2 ─► Kvazaar ─► cam2.hevc ─┤  loop em tempo real           ├─ AS2 (cam2) ─┤   hevcmerge      1 decoder
 inputs/cam3 ─► Kvazaar ─► cam3.hevc ─┼─► dasher (MPD dinâmico) ─HTTP─┼─ AS3 (cam3) ─┼─► (reescreve ─► (VideoToolbox ─► tela
 inputs/cam4 ─► Kvazaar ─► cam4.hevc ─┘   4 AdaptationSets + SRD      └─ AS4 (cam4) ─┘   cabeçalhos)     no Mac)
   (MV restrito, sem TMVP,                (cada câmera continua
    sem WPP, GOP fechado)                  um stream normal)
```

O ponto central: **o servidor não sabe nada de multiview**. Cada câmera é um
stream HEVC comum, tocável sozinho. A decisão de quais câmeras entram e a
costura acontecem no cliente, como no modelo da Tiledmedia.

## Instalação (macOS Apple Silicon)

```bash
git clone <este-repo> hevc-tiles-multiview-poc && cd hevc-tiles-multiview-poc
make deps      # brew install ffmpeg gpac kvazaar + validação
```

`make deps` confere se o GPAC tem os filtros `hevcmerge`, `dashin`, `dasher` e
`httpout`, se o Kvazaar tem `--mv-constraint`/`--no-tmvp` e se o GPAC tem
`vtbdec` (decode HEVC em hardware via VideoToolbox).

## Passo a passo

### 1. Seus 4 vídeos (ou fontes sintéticas)

Coloque `cam1.*` a `cam4.*` em `inputs/`. Qualquer formato que o ffmpeg leia;
não precisam ser HEVC nem ter a mesma resolução. Sem arquivos, o `make sources`
gera 4 fontes sintéticas com rótulo e timecode.

### 2. Prova offline

```bash
make offline   # sources -> encode -> merge -> verify
make control   # opcional: mesmo fluxo SEM as restrições (deve divergir)
make open      # abre build/merged_2x2.mp4 no QuickTime
```

O QuickTime deve abrir **uma** trilha 2048x1152 com as 4 câmeras sincronizadas.
Para o macOS é um vídeo HEVC Main comum (tiles fazem parte do perfil Main), então
o decode é uma única sessão do VideoToolbox. Se não abrir, anote: é um dado
importante sobre suporte a tiles no decoder da Apple.

### 3. Prova ao vivo (dois terminais)

```bash
# terminal 1
make live-server

# terminal 2
make live-play                 # janela com o mosaico, 60 s; no fim mostra o grafo e conta os decoders
make live-proof                # sem janela: roda SEM e COM merge e compara
make live-record verify-live   # grava 20 s e confere bit a bit
CAMS=1,4 make live-play        # só as câmeras 1 e 4 (canvas 1024x1152)
```

No `live-play` e no `live-proof`, o GPAC imprime o grafo de filtros. A prova é
esta linha: as 4 `AdaptationSet`s entram no `hevcmerge`, e dele sai **um** PID
para **um** decoder:

```
--(PID AS1)\
--(PID AS2) \
--(PID AS3)  \
--(PID AS4)---> hevcmerge
---(PID AS1) ffdec "ffdec:hevc"        <- no Mac deve aparecer vtbdec
```

Sem o `hevcmerge`, o mesmo grafo mostra quatro decoders, um por câmera.

### 4. Player web com Shaka (merge no navegador)

```bash
# terminal 1
make live-server

# terminal 2
make web        # abre http://127.0.0.1:8081/index.html no navegador padrão
```

Use **Safari** ou **Chrome** no Mac (os dois tocam HEVC via MSE usando o
VideoToolbox). O Firefox normalmente não toca HEVC; a página avisa se o
navegador não suportar.

**Como funciona.** O Shaka Player 5.3.3 roda sem nenhuma modificação. A página
registra um esquema de rede `mv://` no `NetworkingEngine` do Shaka
(`web/mv-shaka.js`):

```
Shaka pede                          o plugin mv:// faz
──────────────────────────────────  ──────────────────────────────────────────────
mv://manifest/merge?cams=1,2,3,4    baixa o live.mpd real e devolve um MPD com
                                    UMA representação 2048x1152 apontando p/ mv://seg/
mv://seg/init.mp4                   baixa os 4 inits e gera o init do canvas
                                    (SPS 2048x1152, PPS com 4 tiles)
mv://seg/123.m4s                    baixa o segmento 123 das 4 câmeras, costura
                                    em JavaScript (web/hevc-merge.js) e devolve 1
```

Para o Shaka e para o MSE existe um único stream de vídeo: um `SourceBuffer`,
uma sessão de decoder. Se uma câmera ainda não publicou o segmento, o plugin
devolve um erro HTTP recuperável e o Shaka tenta de novo, como faria com um 404.

**Na página:**

- **Multiview · 1 decoder**: o mosaico é desenhado num `<canvas>` a partir do
  único `<video>`. O quadro pequeno no canto mostra o que o decoder realmente
  entrega: um frame 2048x1152.
- **Design de layout**: botão com 4 montagens dos 4 sinais, mais o frame cru.
  *Grade 2×2*; *1 grande + 3 à direita*; *1 grande + 3 embaixo*; *Tela cheia + 3
  miniaturas* (sobre a imagem). Nos layouts com uma câmera grande, clique em
  outra câmera para trazê-la ao quadro principal: só o render muda, nada é
  baixado ou decodificado de novo. A escolha fica salva no navegador, e
  `?layout=side|bottom|pip|grid|raw` na URL força um layout. *Frame
  decodificado* mostra o canvas cru, com as bordas dos tiles marcadas.
- **Comparação · 1 player por câmera**: mesmo conteúdo, sem merge, com um
  player Shaka e um `<video>` por câmera. É o contraponto para comparar CPU,
  GPU e o `chrome://media-internals`.
- **Câmeras**: 4 câmeras ou pares (1 e 2, 3 e 4, 1 e 4).
- Painel com players, streams no MSE, resolução decodificada, frames
  decodificados/descartados, latência ao vivo e tempo de merge por segmento.

`make web-test` valida o player web sem navegador, com Node 18+
(`brew install node`): roda o merge em JavaScript e o plugin do Shaka contra o
servidor ao vivo e confere o resultado bit a bit, e testa a página em jsdom com
um Shaka simulado.

### 5. Fonte HLS ou DASH (4 manifestos `.m3u8` / `.mpd`, por exemplo de um Elemental Live)

O player web aceita **4 manifestos, um por canal, cada um HLS (`.m3u8`) ou DASH
(`.mpd`), em qualquer mistura**, no lugar do DASH de 4 AdaptationSets do GPAC. O
formato é detectado pelo conteúdo, não pela extensão. No DASH: um `<MPD>` por canal
com `SegmentTemplate` (com `SegmentTimeline` ou `@duration`), estático ou dinâmico,
segmentos fMP4/CMAF e `BaseURL` em qualquer nível. Não suporta `SegmentList`,
`SegmentBase` (arquivo único) nem vários `Period` num MPD estático.
Segmentos **fMP4/CMAF** ou **MPEG-TS** (o TS é remuxado para fMP4 em JavaScript,
sem recodificar), playlist de mídia ou master (usa a variante HEVC de maior
banda), ao vivo ou VOD. O Shaka continua sem modificação: o plugin `mv://` lê as
playlists, **pareia os segmentos** das câmeras (por `EXT-X-PROGRAM-DATE-TIME`, ou
pelo número de sequência se não houver), faz o merge e entrega um MPD virtual com
uma representação só.

**Antes de tocar, diagnostique os seus streams** (`--sync auto` para câmeras sincronizadas). HLS de um encoder comum
costuma não ser mergeável (ver "O que aprendemos"), e o merge nele não dá erro:
dá imagem sutilmente errada.

```bash
make check-hls HLS="https://.../cam1.m3u8 https://.../cam2.m3u8 https://.../cam3.m3u8 https://.../cam4.m3u8"
```

O diagnóstico faz o mesmo que o player, mostra container, perfil, tile, TMVP e
relógio de cada câmera e, com o `ffmpeg`, **decodifica o resultado e compara cada
tile, quadro a quadro, com a câmera decodificada sozinha**. Essa é a única forma
de saber se os vetores de movimento do encoder respeitam as bordas do tile.

**Canais diferentes (multiview de canais ao vivo).** Os 4 streams não precisam
estar sincronizados: no modo padrão (*Canais independentes*) cada tile mostra o
segmento mais recente do seu canal, sem relógio em comum, e o tempo de saída segue
o canal 1. Isso **não** dispensa o resto do contrato: os 4 canais precisam ter o
mesmo SPS/PPS, a mesma resolução codificada, a mesma taxa de quadros, o mesmo
número de quadros por segmento (GOP fixo, sem GOP adaptativo/scenecut) e o encode
restrito (sem TMVP, vetores dentro do quadro). Em geral isso exige uma rendição
própria para o multiview, produzida com o mesmo template de encoder nos 4 canais.
Para câmeras de um mesmo evento, com relógio comum, use `--sync auto` (CLI) ou
desmarque *Canais independentes*.

**Interface web para colar os 4 streams:**

```bash
make web-hls     # abre http://127.0.0.1:8081/hls.html
```

Cole as 4 URLs (ou as 4 de uma vez, uma por linha, no primeiro campo), clique em
*Verificar streams* e depois em *Tocar multiview*. A verificação da página é
estrutural (container, tile, TMVP, relógio, merge dos últimos segmentos); a prova
bit a bit continua sendo o `make check-hls`, porque exige decodificar.

**CORS.** O navegador bloqueia HLS de outro domínio se o servidor não enviar
CORS, o que é comum em encoders e CDNs. O servidor do `make web` tem um **proxy
local** (`/proxy?url=...`): a página busca os streams por ele, na mesma origem. Como
roda na sua máquina, alcança também o que só a sua rede ou VPN enxerga. Ele
escuta só em `127.0.0.1`, aceita só `http(s)` e recusa `Host`/`Origin` que não
sejam locais. Marque *Passar pelo servidor local* (vem marcado quando disponível).

Também dá para abrir direto o player com `?hls=url1,url2,url3,url4&proxy=1`.

Para testar sem o encoder real, publique as 4 câmeras locais como HLS ao vivo:

```bash
make hls-server              # terminal 1 (HLS_FORMAT=ts para MPEG-TS)
make web-hls                 # terminal 2: página de entrada; use o botão "Usar o HLS local"
make check-hls HLS="http://127.0.0.1:8082/cam1/index.m3u8 http://127.0.0.1:8082/cam2/index.m3u8 http://127.0.0.1:8082/cam3/index.m3u8 http://127.0.0.1:8082/cam4/index.m3u8"
```

`make hls-test` valida todo o caminho HLS sem navegador (fMP4, TS, TS com
B-frames, ao vivo, master, parser). Como não depende do Kvazaar, usa 4 câmeras
HEVC só com quadros intra, onde o merge é exato por construção.

Para HLS que **não** seja mergeável (encoder comum), o caminho é recodificar
antes, como o `scripts/02_encode.sh` faz com os arquivos locais.

## Resultados de referência

Rodada completa feita antes da entrega, em Linux x86_64 (Ubuntu 24.04, Kvazaar
2.3.2, GPAC 26.08-DEV, a mesma linha de versão do Homebrew), com as fontes
sintéticas, 600 frames por câmera:

| Prova | Resultado |
|---|---|
| Offline, bit-exact | 4/4 câmeras, 600/600 frames idênticos |
| Controle negativo | cam1 10/600, cam2 10/600, cam3 10–13/600, cam4 139/600 |
| Ao vivo, decoders | sem merge **4**, com merge **1** (e 2 vs 1 com `CAMS=1,4`) |
| Ao vivo, bit-exact | 4/4 posições, 100% dos frames (624 e 648 frames em duas rodadas) |
| Merge em JavaScript, bit-exact | 4/4 câmeras, 300/300 frames; 2/2 câmeras com o par 2 e 3 |
| Plugin `mv://` do Shaka, bit-exact | 4/4 câmeras, 240/240 frames; 404 vira erro recuperável |
| Custo do merge em JavaScript (Node) | ~20 a 60 ms por segmento de 2 s com 4 câmeras |

Os relatórios dessa rodada estão em [`docs/rodada-referencia/`](docs/rodada-referencia/),
para comparar com o que sair no seu Mac.

**Ainda não rodado no Mac nem num navegador de verdade.** O ambiente onde montei
a POC não tinha navegador, então o playback no Shaka foi validado até a porta do
MSE: o segmento que o plugin entrega ao Shaka é bit-exact, e a página foi
testada com um Shaka simulado. O que falta confirmar no seu Mac:

1. Safari e Chrome aceitam o canvas HEVC com tiles no MSE e tocam liso.
2. No GPAC, o grafo mostra `vtbdec` (VideoToolbox) no lugar do `ffdec`.

Se o VideoToolbox recusar tiles, esse é o achado mais importante da Fase 1 do
plano.

## O que aprendemos (resumo)

Detalhes e evidências em [`docs/APRENDIZADOS.md`](docs/APRENDIZADOS.md).

1. **TMVP precisa ser desligado.** Com ele ligado, a cam1 divergia nos frames 5 a 59: o candidato temporal "bottom-right" cai no tile vizinho depois do merge.
2. **WPP + tiles quebrou o decode** quando havia tiles lado a lado com controle de taxa. Desligamos o WPP (também é a combinação mais aceita por decoders de hardware).
3. **Largura e altura do tile em múltiplos de 64** (tamanho do CTU).
4. **O nível HEVC sinalizado precisa caber o canvas**, não o tile. O Kvazaar sinaliza 6.2 por padrão; fixamos 5.1.
5. **GOP alinhado ao segmento e duração do clipe múltipla do GOP**, senão o loop ao vivo desalinha os IDRs e os segmentos atrasam.
6. **O cliente entra alguns segundos atrás do live edge** (`init_timeshift`), senão pede segmentos ainda não publicados.

## Limitações (de propósito)

- Há dois players: o GPAC (prova técnica, conta decoders) e o Shaka na página
  web. Android (Media3/MediaCodec) e iOS/tvOS (VideoToolbox) ficam para a
  próxima fase ([`docs/PLANO.md`](docs/PLANO.md)).
- O merge em JavaScript implementa só o contrato desta POC: grade de 2 ou 4
  câmeras do mesmo tamanho, 1 slice por quadro, mesmos SPS/PPS, sem WPP. Fora
  disso ele recusa com uma mensagem clara, em vez de gerar vídeo corrompido.
- No player web, o layout é desenhado num `<canvas>` (2D). Em produção, WebGL ou
  o próprio compositor do player seriam mais eficientes.
- Tiles de mesmo tamanho. Os layouts "1 grande + 3 pequenos" são só de render:
  a câmera grande é um tile 1024x576 ampliado. Para ela ter mais nitidez, seria
  preciso encodar cada câmera em mais de uma resolução (próximo passo natural).
- O servidor faz loop de arquivos já codificados (contribuição simulada). O
  Kvazaar em tempo real no Mac pode não sustentar 4 câmeras; não foi o foco.
- Sem DRM, conforme o escopo.

## Estrutura

```
config.env                  parâmetros (resolução, GOP, bitrate, porta)
Makefile                    atalhos
scripts/00_deps.sh          instala e valida ferramentas
scripts/01_test_sources.sh  fontes sintéticas
scripts/02_encode.sh        Kvazaar com as restrições de merge
scripts/03_merge.sh         hevcmerge offline
scripts/04_verify.sh        prova offline bit-exact
scripts/05_live_server.sh   servidor DASH ao vivo (GPAC)
scripts/06_live_client.sh   cliente: play | proof | record
scripts/07_negative_control.sh  controle negativo
scripts/08_verify_live.sh   prova bit-exact da gravação ao vivo (ou de qualquer MP4/HEVC mergeado)
scripts/09_web.sh           serve a página do player web e abre o navegador
scripts/10_web_test.sh      testes do player web sem navegador
scripts/11_hls_server.sh    publica as 4 câmeras locais como HLS ao vivo (ffmpeg + CORS)
web/index.html, app.js      página: Shaka, modos, layouts, painel
web/mv-shaka.js             plugin mv:// do Shaka + reescrita do MPD
web/hevc-merge.js           merge HEVC em JavaScript (SPS/PPS/slice header + fMP4)
web/hls.html, hls-page.js   página para colar os 4 streams HLS, verificar e tocar
web/hls-check.js            diagnóstico estrutural (usado pela página e pelo make check-hls)
scripts/web_server.py       servidor da página + proxy local (/proxy) contra CORS
web/hls.js                  parser de playlists HLS e pareamento dos segmentos entre câmeras
web/hls-source.js           fonte HLS: MPD virtual com SegmentTimeline e segmentos mergeados
web/ts-remux.js             MPEG-TS -> fMP4 (só HEVC), para HLS com segmentos .ts
tools/check-hls.mjs         diagnóstico: 4 HLS são mergeáveis? (inclui prova bit a bit)
tools/test-hls.mjs          testes do caminho HLS, sem navegador
web/vendor/                 Shaka Player 5.3.3 (dash build) e licença
tools/                      testes em Node (merge, plugin, página em jsdom)
docs/PLANO.md               plano em fases até produção
docs/APRENDIZADOS.md        restrições descobertas, com evidência
```

## Referências

- GPAC, [HEVC Tile based adaptation guide](https://wiki.gpac.io/Howtos/dash/HEVC-Tile-based-adaptation-guide/) e [hevcmerge](https://wiki.gpac.io/Filters/hevcmerge/)
- Kvazaar, [ultravideo/kvazaar](https://github.com/ultravideo/kvazaar)
- Fraunhofer HHI, [omaf.js](https://github.com/hellge/omaf.js): merge de tiles HEVC em JavaScript para MSE
- Shaka Player, [shaka-project/shaka-player](https://github.com/shaka-project/shaka-player) (plugins de rede via `NetworkingEngine.registerScheme`)
- Nokia, [Multiview live streaming with VVC](https://www.nokia.com/blog/be-your-own-director-multiview-live-streaming-with-vvc/)
- MediaKind, [Multiview streaming](https://www.mediakind.com/?p=14725) (integração com a Tiledmedia)
