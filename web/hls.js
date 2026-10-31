// hls.js
// Leitura de playlists HLS (master e media) e alinhamento dos segmentos entre
// câmeras. Sem DOM e sem rede: recebe texto, devolve estruturas. Roda no
// navegador e no Node.

const attrs = (s) => {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
};

export function isMasterPlaylist(text) { return /^#EXT-X-STREAM-INF:/m.test(text); }

// Playlist master -> variantes de vídeo (ordenadas da maior para a menor banda).
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(lines[i].slice(18));
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
    variants.push({
      uri: new URL(uri, baseUrl).href, bandwidth: Number(a.BANDWIDTH || 0),
      codecs: a.CODECS || '', width: w || null, height: h || null,
    });
  }
  return variants.sort((x, y) => y.bandwidth - x.bandwidth);
}

// Escolhe a variante HEVC de maior banda (ou a maior, se o master não disser o codec).
export function pickVariant(variants) {
  if (!variants.length) throw new Error('playlist master sem variantes');
  const hevc = variants.filter((v) => /hvc1|hev1|hevc/i.test(v.codecs));
  return (hevc[0] || variants[0]);
}

// Playlist de mídia -> { targetDuration, mediaSequence, endList, map, container, segments }.
export function parseMedia(text, baseUrl) {
  if (!text.startsWith('#EXTM3U')) throw new Error('não é uma playlist HLS (falta #EXTM3U)');
  const pl = { targetDuration: 0, mediaSequence: 0, endList: false, map: null, segments: [], container: 'unknown', version: 1 };
  let dur = null, pdt = null, disc = false, range = null;
  let seq = 0, lastPdt = null, lastDur = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const [tag, ...rest] = line.slice(1).split(':');
      const val = rest.join(':');
      switch (tag) {
        case 'EXT-X-VERSION': pl.version = Number(val); break;
        case 'EXT-X-TARGETDURATION': pl.targetDuration = Number(val); break;
        case 'EXT-X-MEDIA-SEQUENCE': pl.mediaSequence = Number(val); seq = pl.mediaSequence; break;
        case 'EXT-X-ENDLIST': pl.endList = true; break;
        case 'EXT-X-PLAYLIST-TYPE': pl.playlistType = val; break;
        case 'EXT-X-KEY': {
          const a = attrs(val);
          if (a.METHOD && a.METHOD !== 'NONE') throw new Error(`segmentos criptografados (${a.METHOD}) não são suportados: o projeto não faz DRM`);
          break;
        }
        case 'EXT-X-MAP': {
          const a = attrs(val);
          if (a.BYTERANGE) throw new Error('EXT-X-MAP com BYTERANGE não é suportado');
          pl.map = new URL(a.URI, baseUrl).href;
          break;
        }
        case 'EXTINF': dur = Number(val.split(',')[0]); break;
        case 'EXT-X-BYTERANGE': range = val; break;
        case 'EXT-X-PROGRAM-DATE-TIME': pdt = Date.parse(val); break;
        case 'EXT-X-DISCONTINUITY': disc = true; break;
        default: break;
      }
      continue;
    }
    if (dur === null) continue;
    if (range) throw new Error('segmentos com EXT-X-BYTERANGE não são suportados');
    if (pdt === null && lastPdt !== null) pdt = lastPdt + lastDur * 1000; // PDT só no 1º segmento: propaga
    const uri = new URL(line, baseUrl).href;
    pl.segments.push({ seq: seq++, uri, dur, pdt, discontinuity: disc });
    lastPdt = pdt; lastDur = dur;
    dur = null; pdt = null; disc = false;
  }
  if (!pl.segments.length) throw new Error('playlist sem segmentos');
  const first = pl.segments[0].uri.split('?')[0].toLowerCase();
  if (pl.map) pl.container = 'fmp4';
  else if (/\.(ts|m2ts)$/.test(first)) pl.container = 'ts';
  else if (/\.(m4s|mp4|cmfv|m4v)$/.test(first)) pl.container = 'fmp4';
  if (pl.segments.some((s) => s.discontinuity)) pl.hasDiscontinuity = true;
  return pl;
}

// Pareia os segmentos das câmeras. Prefere EXT-X-PROGRAM-DATE-TIME (as câmeras
// podem ter numerações diferentes); sem ele, usa o número de sequência.
// Devolve { mode, slots: [{ id, uris:[por câmera], dur, pdt }], skew }.
//   id   = número de sequência da câmera 1 (estável entre atualizações da playlist)
//   skew = maior diferença de PDT (ms) entre câmeras num mesmo slot (diagnóstico)
export function alignSlots(playlists) {
  const ref = playlists[0];
  const allPdt = playlists.every((p) => p.segments.every((s) => s.pdt !== null));
  const mode = allPdt ? 'pdt' : 'seq';
  const slots = [];
  let skew = 0;
  for (const s of ref.segments) {
    const uris = [s.uri];
    let ok = true;
    for (const p of playlists.slice(1)) {
      let m;
      if (mode === 'pdt') {
        m = p.segments.reduce((best, c) => (!best || Math.abs(c.pdt - s.pdt) < Math.abs(best.pdt - s.pdt) ? c : best), null);
        if (!m || Math.abs(m.pdt - s.pdt) > Math.min(s.dur, m.dur) * 500) { ok = false; break; }
        skew = Math.max(skew, Math.abs(m.pdt - s.pdt));
      } else {
        m = p.segments.find((c) => c.seq === s.seq);
        if (!m) { ok = false; break; }
      }
      uris.push(m.uri);
    }
    if (ok) slots.push({ id: s.seq, uris, dur: s.dur, pdt: s.pdt });
  }
  return { mode, slots, skew };
}
