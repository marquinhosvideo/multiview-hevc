// hls-check.js
// Diagnóstico de 4 (ou 2) streams HLS: dá para fazer o merge de tiles com eles?
// Usado pela página hls.html (navegador) e por tools/check-hls.mjs (Node). Faz o
// que o player faz: lê as playlists, alinha, remuxa TS, e costura os últimos
// segmentos. Não decodifica nada; a prova bit a bit fica a cargo do ffmpeg (CLI).

import { createHlsSource } from './hls-source.js';
import { parseCameraInit, initCodecString } from './hevc-merge.js';

// -> { ok, error?, canvas, info, cams, checks:[{kind:'ok'|'warn'|'bad', msg}], merged, source }
export async function diagnose(urls, { fetchBytes, segments = 3, sync = 'auto', rendition = 'highest', wppRow = false, lenient = false } = {}) {
  const checks = [];
  const add = (kind, msg) => checks.push({ kind, msg });
  const events = [];
  const source = createHlsSource({ fetchBytes, onEvent: (e) => events.push(e) });

  let m;
  try { m = await source.refresh(urls, { sync, rendition, wppRow, lenient }); }
  catch (e) {
    add('bad', `não consegui montar o merge: ${e.message}`);
    return { ok: false, error: e.message, checks, source };
  }
  for (const e of events) if (e.type === 'warning') add('warn', e.message);
  for (const e of events) if (e.type === 'info') add('ok', e.message);

  const cams = source.state.cams.map((c) => {
    const p = parseCameraInit(c.init), h = p.hvcC.header;
    return {
      index: c.index, container: c.container, profile: h[1] & 31, level: h[12] / 30,
      width: p.sps.width, height: p.sps.height, ctb: p.sps.ctbSize, tmvp: p.sps.temporalMvpEnabled,
      bits: p.sps.bitDepthLuma, codec: initCodecString(c.init), url: c.url, mediaUrl: c.mediaUrl,
    };
  });

  if (cams.every((c) => c.container === 'fmp4')) add('ok', 'segmentos fMP4/CMAF: sem conversão');
  else add('ok', `segmentos ${cams.map((c) => c.container.toUpperCase()).join('/')}: remuxados para fMP4 no cliente (sem recodificar)`);
  const sizes = [...new Set(cams.map((c) => `${c.width}x${c.height}`))];
  if (sizes.length > 1) add('bad', `os canais têm resolução codificada diferente (${sizes.join(', ')}): todos precisam ter o mesmo tamanho; escolha, em cada canal, uma variante da mesma resolução`);
  else {
    const mg = source.state.merger;
    add('ok', `tile ${cams[0].width}x${cams[0].height} (CTU ${cams[0].ctb}): ${mg.cols} coluna(s) x ${mg.rows} linha(s) de tiles, canvas ${mg.width}x${mg.height}, nível ${(mg.level / 30).toFixed(1)}`);
    if (mg.width > 4096 || mg.height > 4096 || mg.width * mg.height > 8912896) {
      add(mg.width * mg.height > 35651584 ? 'bad' : 'warn', `o canvas ${mg.width}x${mg.height} é grande: muitos decoders de hardware limitam o quadro a 4096 em cada lado e a ~8,9 Mpixels; use uma variante menor dos canais (opção de qualidade)`);
    }
  }
  if (m.info.mode === 'independent') { /* já informado acima */ }
  else if (m.info.mode === 'pdt') add(m.info.skew <= 40 ? 'ok' : 'warn', `desvio de relógio entre câmeras (PDT): até ${m.info.skew.toFixed(0)} ms`);
  else add('warn', 'sem EXT-X-PROGRAM-DATE-TIME: o pareamento depende de as câmeras numerarem os segmentos de forma idêntica');
  if (cams.some((c) => c.tmvp)) {
    add('warn', `CAM ${cams.find((c) => c.tmvp).index}: TMVP ligado no SPS; a predição temporal de vetor pode cruzar a borda do tile (só a prova bit a bit confirma)`);
  } else add('ok', 'TMVP desligado em todas as câmeras');

  if (source.state.merger && source.state.merger.wppRow) {
    add('warn', 'EXPERIMENTAL: WPP com os tiles lado a lado (altura não múltipla do CTU). A especificação HEVC permite, mas o FFmpeg não decodifica e não consegui testar decoders de hardware; se a imagem vier corrompida ou não tocar, desligue o WPP no encoder');
  } else if (source.state.merger && source.state.merger.wpp) {
    add('warn', 'WPP ligado nos canais: mantive o WPP e empilhei os tiles na vertical (1 coluna), porque tiles lado a lado + WPP quebra o decode. Tiles + WPP no mesmo stream é raro e alguns decoders de hardware recusam; se o vídeo não tocar, desligue o WPP no encoder');
  }
  if (lenient) add('warn', 'validação de GOP desligada: se os canais tiverem estrutura de quadros diferente, o vídeo mergeado é inválido e o decoder pode travar ou corromper a imagem');
  const times = [...source.state.slotsByTime.keys()].slice(-segments);
  const merged = [];
  for (const t of times) {
    try { merged.push({ t, ...(await source.mergedSegment(t)) }); }
    catch (e) { add('bad', `merge do segmento ${t}: ${e.message}`); }
  }
  if (merged.length && merged.length === times.length) add('ok', `merge estrutural: ${merged.length} segmentos costurados (1 slice por quadro, IDR e tempos alinhados)`);

  return {
    ok: !checks.some((c) => c.kind === 'bad'),
    canvas: { width: m.width, height: m.height, grid: m.grid },
    info: m.info, cams, checks, merged, source,
  };
}
