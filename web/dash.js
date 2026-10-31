// dash.js
// Leitor de manifesto DASH (MPD) de UM canal de vídeo, devolvendo a mesma estrutura
// que web/hls.js devolve para uma playlist HLS. Assim, um canal pode ser dado como
// .m3u8 ou como .mpd, e o resto do projeto (pareamento, merge, player) não muda.
//
// Suporta SegmentTemplate com SegmentTimeline ou com @duration, estático ou dinâmico,
// $RepresentationID$ / $Number$ / $Time$ / $Bandwidth$ (com %0Nd) e BaseURL em
// qualquer nível. Não suporta SegmentList, SegmentBase (arquivo único), vários
// Periods num MPD estático, nem criptografia. Sem DOMParser: roda no Node e no navegador.

// ---------------------------------------------------------------- XML mínimo
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += m[6];
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '')] = decode(a[2] ?? a[3]);
      const el = { name: m[3].replace(/^.*:/, ''), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return root.children[0] || null;
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0];

export function isMpd(text) { return /<MPD[\s>]/.test(text.slice(0, 4000)); }

// "PT1H2M3.5S" -> segundos
export function parseDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// Substitui $RepresentationID$, $Number$, $Time$, $Bandwidth$ (com formato %0Nd).
function expand(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_, k, w) => {
    const v = String(vars[k]);
    return w ? v.padStart(Number(w), '0') : v;
  }).replace(/\$\$/g, '$');
}

// -> mesma forma de parseMedia() em hls.js:
//   { targetDuration, mediaSequence, endList, map, container, segments:[{seq, uri, dur, pdt}], source:'dash' }
// opts.now: relógio (ms) para MPD dinâmico com @duration; opts.seqState: Map t->seq que o chamador
// mantém entre atualizações, para os números de sequência continuarem consecutivos.
export function parseMpd(text, baseUrl, { now = Date.now(), seqState = new Map(), rendition = 'highest' } = {}) {
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') throw new Error('não é um manifesto DASH (sem <MPD>)');
  if (mpd.attrs.type === 'dynamic' || mpd.attrs.type === undefined || mpd.attrs.type === 'static') { /* ok */ }
  const dynamic = mpd.attrs.type === 'dynamic';
  const periods = kids(mpd, 'Period');
  if (!periods.length) throw new Error('MPD sem <Period>');
  if (!dynamic && periods.length > 1) throw new Error('MPD estático com vários Periods não é suportado');
  const period = periods[periods.length - 1];

  // Adaptation sets de vídeo; prefere HEVC.
  const isVideo = (as) => /video/.test(`${as.attrs.contentType || ''} ${as.attrs.mimeType || ''} ${kids(as, 'Representation').map((r) => r.attrs.mimeType || '').join(' ')}`)
    || kids(as, 'Representation').some((r) => r.attrs.width);
  const sets = kids(period, 'AdaptationSet').filter(isVideo);
  if (!sets.length) throw new Error('MPD sem AdaptationSet de vídeo');
  const isHevc = (c) => /hvc1|hev1|hevc/i.test(c || '');
  const cands = sets.flatMap((as) => kids(as, 'Representation').map((rep) => ({ as, rep, codecs: rep.attrs.codecs || as.attrs.codecs || '' })));
  const hevc = cands.filter((c) => isHevc(c.codecs));
  if (!hevc.length && cands.every((c) => /avc|h264/i.test(c.codecs))) {
    throw new Error(`o canal DASH é H.264 (${cands[0].codecs}), não HEVC: tiles só existem em HEVC`);
  }
  const pool = hevc.length ? hevc : cands;
  const hOf = (c) => Number(c.rep.attrs.height || c.as.attrs.height || 0);
  const byBw = (a, b) => Number(b.rep.attrs.bandwidth || 0) - Number(a.rep.attrs.bandwidth || 0);
  const byHeight = (a, b) => hOf(b) - hOf(a) || byBw(a, b);
  const max = Number(rendition);
  let chosen;
  if (rendition === 'lowest') chosen = [...pool].sort((a, b) => -byHeight(a, b))[0];
  else if (Number.isFinite(max) && max > 0) chosen = pool.filter((c) => hOf(c) && hOf(c) <= max).sort(byHeight)[0] || [...pool].sort((a, b) => -byHeight(a, b))[0];
  else chosen = [...pool].sort(byBw)[0];
  const { as, rep, codecs } = chosen;

  // BaseURL em cascata
  let base = baseUrl;
  for (const el of [mpd, period, as, rep]) { const b = kid(el, 'BaseURL'); if (b && b.text.trim()) base = new URL(b.text.trim(), base).href; }

  const tpl = kid(rep, 'SegmentTemplate') || kid(as, 'SegmentTemplate') || kid(period, 'SegmentTemplate');
  if (!tpl) {
    if (kid(rep, 'SegmentList') || kid(as, 'SegmentList')) throw new Error('SegmentList não é suportado; use SegmentTemplate');
    throw new Error('MPD sem SegmentTemplate (SegmentBase/arquivo único, on-demand): não suportado');
  }
  const a = tpl.attrs;
  const timescale = Number(a.timescale || 1);
  const pto = Number(a.presentationTimeOffset || 0);
  const startNumber = Number(a.startNumber ?? 1);
  const vars = { RepresentationID: rep.attrs.id ?? '', Bandwidth: rep.attrs.bandwidth ?? '' };
  if (!a.media) throw new Error('SegmentTemplate sem @media');
  const mimeType = rep.attrs.mimeType || as.attrs.mimeType || 'video/mp4';
  if (!/mp4/.test(mimeType)) throw new Error(`segmentos DASH ${mimeType} não são suportados (só fMP4/CMAF)`);

  const ast = dynamic ? Date.parse(mpd.attrs.availabilityStartTime || '1970-01-01T00:00:00Z') : 0;
  const periodStart = parseDuration(period.attrs.start) || 0;
  const entries = []; // { t, d, number }
  const timeline = kid(tpl, 'SegmentTimeline') || kid(kid(as, 'SegmentTemplate'), 'SegmentTimeline');
  if (timeline) {
    let t = 0, idx = 0, first = true;
    for (const s of kids(timeline, 'S')) {
      if (s.attrs.t !== undefined) t = Number(s.attrs.t); else if (first) t = pto;
      first = false;
      const d = Number(s.attrs.d);
      let r = Number(s.attrs.r || 0);
      if (r < 0) { // repete até o fim do período / agora
        const endSec = dynamic ? (now - ast) / 1000 - periodStart : (parseDuration(mpd.attrs.mediaPresentationDuration) || 0);
        r = Math.max(0, Math.floor((endSec * timescale - (t - pto)) / d) - 1);
      }
      for (let i = 0; i <= r; i++) { entries.push({ t, d, number: startNumber + idx }); t += d; idx++; }
    }
  } else if (a.duration) {
    const d = Number(a.duration), segSec = d / timescale;
    let from = 0, to;
    if (dynamic) {
      const availSec = (now - ast) / 1000 - periodStart;
      const tsb = parseDuration(mpd.attrs.timeShiftBufferDepth) ?? segSec * 10;
      to = Math.floor(availSec / segSec) - 1; // último segmento completo
      from = Math.max(0, Math.floor((availSec - tsb) / segSec));
    } else {
      const total = parseDuration(period.attrs.duration) ?? parseDuration(mpd.attrs.mediaPresentationDuration);
      if (!total) throw new Error('MPD estático sem duração');
      to = Math.ceil(total / segSec) - 1;
    }
    for (let i = from; i <= to; i++) entries.push({ t: pto + i * d, d, number: startNumber + i, abs: i });
  } else throw new Error('SegmentTemplate sem SegmentTimeline nem @duration');
  if (!entries.length) throw new Error('o MPD não lista segmentos ainda');

  // Números de sequência consecutivos e estáveis entre atualizações.
  let next = seqState.size ? Math.max(...seqState.values()) + 1 : 0;
  const segments = entries.map((e) => {
    if (e.abs !== undefined) seqState.set(e.t, e.abs);
    else if (!seqState.has(e.t)) seqState.set(e.t, next++);
    const uri = new URL(expand(a.media, { ...vars, Number: e.number, Time: e.t }), base).href;
    return {
      seq: seqState.get(e.t), uri, dur: e.d / timescale, discontinuity: false,
      pdt: dynamic ? ast + (periodStart + (e.t - pto) / timescale) * 1000 : null,
    };
  });
  const init = a.initialization ? new URL(expand(a.initialization, vars), base).href : null;
  if (!init) throw new Error('SegmentTemplate sem @initialization');
  return {
    source: 'dash', version: 7, targetDuration: Math.ceil(Math.max(...segments.map((s) => s.dur))),
    mediaSequence: segments[0].seq, endList: !dynamic, map: init, container: 'fmp4', segments,
    codecs, width: Number(rep.attrs.width || as.attrs.width || 0) || null, height: Number(rep.attrs.height || as.attrs.height || 0) || null,
  };
}
