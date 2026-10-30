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

## Resultados de referência

Rodada completa feita antes da entrega, em Linux x86_64 (Ubuntu 24.04, Kvazaar
2.3.2, GPAC 26.08-DEV, a mesma linha de versão do Homebrew), com as fontes
sintéticas, 600 frames por câmera:

| Prova | Resultado |
|---|---|
| Offline, bit-exact | 4/4 câmeras, 600/600 frames idênticos |
| Controle negativo | cam1 10/600, cam2 10/600, cam3 13/600, cam4 139/600 |
| Ao vivo, decoders | sem merge **4**, com merge **1** (e 2 vs 1 com `CAMS=1,4`) |
| Ao vivo, bit-exact | 4/4 posições, 624/624 frames idênticos |

**Ainda não rodado no Mac.** No Apple Silicon espero o `vtbdec` no lugar do
`ffdec` no grafo. Se o VideoToolbox recusar o bitstream com tiles, o GPAC cai
para software e a prova de "1 decoder" continua valendo, mas aí o ponto de
hardware fica em aberto e vale registrar.

## O que aprendemos (resumo)

Detalhes e evidências em [`docs/APRENDIZADOS.md`](docs/APRENDIZADOS.md).

1. **TMVP precisa ser desligado.** Com ele ligado, a cam1 divergia nos frames 5 a 59: o candidato temporal "bottom-right" cai no tile vizinho depois do merge.
2. **WPP + tiles quebrou o decode** quando havia tiles lado a lado com controle de taxa. Desligamos o WPP (também é a combinação mais aceita por decoders de hardware).
3. **Largura e altura do tile em múltiplos de 64** (tamanho do CTU).
4. **O nível HEVC sinalizado precisa caber o canvas**, não o tile. O Kvazaar sinaliza 6.2 por padrão; fixamos 5.1.
5. **GOP alinhado ao segmento e duração do clipe múltipla do GOP**, senão o loop ao vivo desalinha os IDRs e os segmentos atrasam.
6. **O cliente entra alguns segundos atrás do live edge** (`init_timeshift`), senão pede segmentos ainda não publicados.

## Limitações (de propósito)

- O "player" aqui é o GPAC. Ele prova a técnica; não é um player de produção.
  Integrar em web (MSE), Android (Media3/MediaCodec) e iOS/tvOS (VideoToolbox) é
  a próxima fase ([`docs/PLANO.md`](docs/PLANO.md)).
- O canvas é exibido como está. Layout livre na tela (redimensionar, trocar a
  principal) é trabalho do renderizador, depois do decode.
- Tiles de mesmo tamanho. Mosaico "1 grande + 3 pequenos" exige encodar cada
  câmera em mais de uma resolução, o que é o próximo passo natural.
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
scripts/08_verify_live.sh   prova bit-exact da gravação ao vivo
docs/PLANO.md               plano em fases até produção
docs/APRENDIZADOS.md        restrições descobertas, com evidência
```

## Referências

- GPAC, [HEVC Tile based adaptation guide](https://wiki.gpac.io/Howtos/dash/HEVC-Tile-based-adaptation-guide/) e [hevcmerge](https://wiki.gpac.io/Filters/hevcmerge/)
- Kvazaar, [ultravideo/kvazaar](https://github.com/ultravideo/kvazaar)
- Fraunhofer HHI, [omaf.js](https://github.com/hellge/omaf.js): merge de tiles HEVC em JavaScript para MSE
- Nokia, [Multiview live streaming with VVC](https://www.nokia.com/blog/be-your-own-director-multiview-live-streaming-with-vvc/)
- MediaKind, [Multiview streaming](https://www.mediakind.com/?p=14725) (integração com a Tiledmedia)
