# Plano: da POC à decisão build vs buy

Objetivo: decidir, com evidência, se vale construir multiview com decode único
dentro dos players da Globo ou comprar (Tiledmedia ou similar). Escopo: ao vivo,
sem DRM.

## Fase 0: POC de técnica ✅ (este repositório)

**Pergunta:** a técnica funciona com ferramentas abertas?

**Resposta:** sim. 4 câmeras HEVC independentes, merge no cliente, 1 decoder,
resultado bit a bit idêntico, ao vivo via DASH. Ver `README.md` e `proof/`.

## Fase 1: validação no Mac (1 a 2 dias)

**Pergunta:** o decoder de hardware da Apple aceita o bitstream mergeado?

| Teste | Critério de sucesso |
|---|---|
| `make deps offline control` | Mesmos resultados da rodada de referência |
| `make open` (QuickTime) | Toca liso, 4 câmeras sincronizadas |
| `make live-play` | Grafo mostra `vtbdec` x1 |
| `make live-proof` | 4 decoders sem merge, 1 com merge |
| `make web` no Safari e no Chrome | Mosaico toca liso; painel mostra 1 player e 2048x1152 decodificado; `chrome://media-internals` mostra 1 player |
| Modo Comparação na página | Registrar CPU/GPU com 4 players vs 1 (Monitor de Atividade) |
| Monitor de Atividade durante `live-play` com e sem merge | Registrar CPU do processo `gpac` |

Se o `vtbdec` não aparecer ou falhar, é o primeiro sinal de risco de
compatibilidade em hardware, e muda as fases seguintes.

## Fase 2: realismo do encoding (1 a 2 semanas)

**Pergunta:** o que isso custa e exige da cadeia de encoding de produção?

1. **Custo de compressão das restrições.** Encodar as mesmas fontes com e sem
   `--mv-constraint` / `--no-tmvp` / `--no-wpp` e medir a diferença de bitrate na
   mesma qualidade (VMAF ou PSNR). Hipótese: poucos por cento, mas é o número que
   finanças e CDN vão pedir.
2. **Encoder de produção.** Confirmar com os fornecedores de encoder ao vivo se
   eles expõem: restrição de vetor de movimento à borda, TMVP off, WPP off, GOP
   fechado e **IDR alinhado entre canais**. Sem isso, a técnica depende de um
   encoder dedicado só para multiview.
3. **Multi-resolução.** O layout "1 grande + 3 pequenas" exige cada câmera em
   pelo menos 2 resoluções compatíveis entre si. O GPAC tem um guia para isso
   (*HEVC Tile multi resolution adaptation*); repetir a prova bit-exact nesse modo.
4. **Live de verdade.** Trocar o loop de arquivos por 4 encoders ao vivo
   sincronizados e medir latência glass-to-glass do mosaico vs um canal único.

## Fase 3: integração nos players (2 a 4 semanas por plataforma, em paralelo)

**Pergunta:** quanto custa colocar o merge antes do decoder em cada plataforma?

O trabalho é sempre o mesmo: baixar N streams, reescrever SPS/PPS/slice header
(o que o `hevcmerge` faz em ~1.700 linhas de C, apoiado nos parsers HEVC do
GPAC), entregar ao decoder nativo e
recortar na renderização. O que muda é onde dá para "entrar" antes do decoder:

| Plataforma | Onde entra o merge | Referência | Risco principal |
|---|---|---|---|
| Web / Safari / Tizen / webOS | **Já iniciado nesta POC:** plugin `mv://` no `NetworkingEngine` do Shaka, merge em JS antes do `SourceBuffer` | `web/mv-shaka.js`, `web/hevc-merge.js`; [omaf.js](https://github.com/hellge/omaf.js) | Suporte a HEVC no MSE e a tiles no decoder da TV |
| Android / Android TV | Renderer customizado no Media3 alimentando o `MediaCodec` | `hevcmerge` portado (C via JNI) | Variação de decoder entre fabricantes de SoC |
| iOS / tvOS | `VTDecompressionSession` + `AVSampleBufferDisplayLayer` (o `AVPlayer` não serve) | idem | Perder o que o AVPlayer dá de graça (AirPlay, PiP, legendas) |
| Roku / LG em C | Depende de acesso ao decoder abaixo do player nativo | — | Provavelmente inviável; candidatos a multiview server-side |

Recomendação de ordem: **Web primeiro**, que já tem o esqueleto funcionando no
Shaka; o próximo passo natural é rodar a mesma página no navegador de uma TV
Tizen ou webOS, onde o limite de decoders é real. Depois **Android TV**.

O padrão do plugin de rede vale fora do Shaka também: qualquer player que deixe
interceptar o download de segmentos e devolver bytes próprios pode receber o
mesmo `hevc-merge.js` (no hls.js, um `loader` customizado; no dash.js, avaliar
os pontos de extensão de request/response da versão em uso).

## Fase 4: decisão

| Critério | Build (esta técnica) | Buy (Tiledmedia) | Server-side composition |
|---|---|---|---|
| Layout livre por usuário | Sim | Sim | Não (layouts fixos) |
| Funciona em qualquer TV | Depende do decoder | Depende do SDK | Sim |
| Custo de encoding | 1 encode por câmera | 1 encode por câmera | 1 encode por combinação de layout |
| Custo de player | Alto (por plataforma) | SDK + licença | Zero |
| Controle do roadmap | Total | Do fornecedor | Total |
| Patentes | Avaliar (Fraunhofer, Nokia, Tiledmedia têm patentes na área) | Coberto pelo contrato? | Baixo risco |

Hipótese a testar: **híbrido**. Server-side para Roku/TVs legadas, merge no
cliente onde o player é nosso e o decoder aceita.

## Questão em aberto: AV1

A Plataforma está migrando para AV1. Esta POC é HEVC porque é onde existe
ferramental aberto maduro para merge de tiles. AV1 tem tiles, mas não achei
ferramenta aberta de merge equivalente ao `hevcmerge`. Antes da Fase 3, vale uma
pesquisa curta (1 a 2 dias) sobre o estado do merge de tiles em AV1, para não
investir em integração de player só para HEVC.

## Riscos

- **Suporte a tiles nos decoders de hardware.** Tiles são obrigatórios no perfil
  Main, mas "obrigatório" e "testado pelo fabricante" são coisas diferentes.
  Precisa de matriz de dispositivos (encaixa no esforço de testes automatizados
  em dispositivos reais).
- **Dependência de encoder.** Se nenhum encoder de produção expuser as
  restrições, o custo sobe muito.
- **Patentes.** Código aberto não resolve patentes; precisa de avaliação
  jurídica antes da Fase 3.
