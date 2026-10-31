// Página da POC: Shaka Player tocando o canvas HEVC mergeado no navegador.
import { createMultiviewScheme, fetchBytes } from './mv-shaka.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const MPD = params.get('mpd') ||
  (location.port === '8080' ? `${location.origin}/live.mpd` : `http://${location.hostname}:8080/live.mpd`);

const LAYOUTS = ['grid', 'side', 'bottom', 'pip', 'raw'];
const LAYOUT_NAMES = { grid: 'Grade 2×2', side: '1 grande + 3 à direita', bottom: '1 grande + 3 embaixo', pip: 'Tela cheia + 3 miniaturas', raw: 'Frame decodificado' };
function storedLayout() {
  try { const v = localStorage.getItem('mv.layout'); return LAYOUTS.includes(v) ? v : 'grid'; } catch { return 'grid'; }
}

const ui = {
  mode: params.get('mode') === 'compare' ? 'compare' : 'merge',
  layout: LAYOUTS.includes(params.get('layout')) ? params.get('layout') : storedLayout(),
  cams: params.get('cams') || '1,2,3,4',
  focusCam: null,
};
let session = null;    // { players: [{player, video, cam}], token }
let geometry = null;   // { width, height, tiles:[{x,y,w,h}], cams:[n] } do canvas decodificado
let codecs = 'hvc1.1.6.L153.80';
let lastCells = [];
const merge = { segments: 0, ms: 0, lastMs: 0, last: null, bytesIn: 0, bytesOut: 0 };

// ---------------------------------------------------------------- log/banner
function log(msg, kind = '') {
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<time>${new Date().toLocaleTimeString('pt-BR')}</time> ${msg}`;
  const ol = $('#log');
  ol.prepend(li);
  while (ol.children.length > 40) ol.lastChild.remove();
}
function banner(html) { const b = $('#banner'); b.innerHTML = html; b.hidden = !html; }

// ---------------------------------------------------------------- Shaka setup
shaka.polyfill.installAll();
const hevcOk = !!(window.MediaSource && MediaSource.isTypeSupported(`video/mp4; codecs="${codecs}"`));
if (!shaka.Player.isBrowserSupported()) {
  banner('Este navegador não tem Media Source Extensions; o Shaka não roda aqui.');
} else if (!hevcOk) {
  banner('Este navegador não decodifica <b>HEVC via MSE</b>. No Mac, use <b>Safari</b> ou <b>Chrome</b> recente. O Firefox normalmente não toca HEVC.');
}

const scheme = createMultiviewScheme(shaka, {
  fetchBytes,
  xmlApi: { DOMParser, XMLSerializer },
  presentationDelay: Number(params.get('delay') || 6),
  onEvent(e) {
    if (e.type === 'manifest') {
      codecs = e.cameras[0].codecs || codecs;
      if (!geometry || geometry.cams.join() !== e.cameras.map((c) => c.index).join()) {
        log(`manifesto virtual: ${e.cameras.length} câmeras → 1 representação ${e.width}x${e.height} (grade ${e.grid.cols}x${e.grid.rows})`);
      }
      geometry = { ...(geometry || {}), width: e.width, height: e.height, cams: e.cameras.map((c) => c.index) };
    } else if (e.type === 'merger') {
      geometry = { ...(geometry || {}), tiles: e.tiles };
      log(`init do canvas gerado: SPS ${e.width}x${e.height}, PPS com ${e.tiles.length} tiles`);
    } else if (e.type === 'segment') {
      merge.segments++; merge.ms += e.ms; merge.lastMs = e.ms; merge.last = e.number;
      merge.bytesIn += e.bytesIn; merge.bytesOut += e.bytesOut;
      if (merge.segments <= 3 || merge.segments % 10 === 0) {
        log(`segmento ${e.number}: ${e.cams} câmeras → 1 segmento em ${e.ms.toFixed(1)} ms`);
      }
    } else if (e.type === 'error') {
      log(`erro no merge: ${e.message}`, 'err');
      banner(`Erro no merge: ${e.message}`);
    }
  },
});
shaka.net.NetworkingEngine.registerScheme('mv', scheme.plugin);

function configure(player) {
  player.configure({
    manifest: { defaultPresentationDelay: Number(params.get('delay') || 6) },
    abr: { enabled: false },
    streaming: {
      bufferingGoal: 8,
      rebufferingGoal: 2,
      retryParameters: { maxAttempts: 12, baseDelay: 400, backoffFactor: 1.3, fuzzFactor: 0.2, timeout: 0 },
    },
  });
}

async function newPlayer(video, uri, label) {
  const player = new shaka.Player();
  await player.attach(video);
  configure(player);
  player.addEventListener('error', (ev) => {
    const err = ev.detail;
    log(`${label}: erro Shaka ${err.code}${err.data && err.data[0] ? ` (${String(err.data[0]).slice(0, 80)})` : ''}`, 'err');
    if (err.code === 4032 || err.code === 3016) banner('O navegador recusou o HEVC (código ' + err.code + '). Use Safari ou Chrome no macOS.');
  });
  await player.load(uri, null, 'application/dash+xml');
  video.play().catch(() => {});
  return player;
}

// ---------------------------------------------------------------- sessões
async function stop() {
  const s = session; session = null;
  if (!s) return;
  await Promise.all(s.players.map((p) => p.player.destroy().catch(() => {})));
  $('#compare').innerHTML = '';
}

async function start() {
  await stop();
  banner(hevcOk ? '' : $('#banner').innerHTML);
  const token = Symbol('session');
  session = { players: [], token };
  geometry = null; ui.focusCam = null;
  Object.assign(merge, { segments: 0, ms: 0, lastMs: 0, last: null, bytesIn: 0, bytesOut: 0 });
  const cams = ui.cams.split(',').map(Number);
  document.body.dataset.mode = ui.mode;

  try {
    if (ui.mode === 'merge') {
      const video = $('#video');
      const uri = `mv://manifest/merge?cams=${cams.join(',')}&mpd=${encodeURIComponent(MPD)}`;
      log(`Multiview: 1 player Shaka, câmeras ${cams.join(', ')}`);
      const player = await newPlayer(video, uri, 'multiview');
      if (session && session.token === token) session.players.push({ player, video, cam: 'canvas' });
      else player.destroy();
    } else {
      log(`Comparação: ${cams.length} players Shaka, um por câmera`);
      for (const cam of cams) {
        const fig = document.createElement('figure');
        fig.innerHTML = `<video muted playsinline></video><figcaption>CAM ${cam} · player ${cams.indexOf(cam) + 1}</figcaption>`;
        $('#compare').append(fig);
        const video = fig.querySelector('video');
        const uri = `mv://manifest/cam?cam=${cam}&mpd=${encodeURIComponent(MPD)}`;
        const player = await newPlayer(video, uri, `CAM ${cam}`);
        if (session && session.token === token) session.players.push({ player, video, cam });
        else { player.destroy(); return; }
      }
    }
  } catch (err) {
    const code = err && err.code;
    log(`falha ao carregar: ${code ? 'Shaka ' + code : err.message || err}`, 'err');
    if (code === 4032 || code === 4012) banner('Nenhuma variante tocável: o navegador não aceitou o HEVC. Use Safari ou Chrome no macOS.');
    else if (code === 1001 || code === 1002) banner(`Não consegui falar com o servidor ao vivo em <code>${MPD}</code>. Ele está rodando (<code>make live-server</code>)?`);
  }
}

// ---------------------------------------------------------------- render do mosaico
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

function fit(srcW, srcH, cell) {
  const s = Math.min(cell.w / srcW, cell.h / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

// Posição de cada câmera no canvas de saída, por layout. Só o render muda: o
// decoder continua entregando o mesmo frame 2048x1152, e cada câmera é um
// recorte (tile) dele.
function cellsFor(layout, tiles, W, H, focusIdx) {
  const n = tiles.length;
  const gap = Math.round(6 * devicePixelRatio);
  const others = [...Array(n).keys()].filter((i) => i !== focusIdx);
  const cells = new Array(n);
  if (layout === 'side' && n > 1) {
    const mainW = Math.round(W * 0.74);
    cells[focusIdx] = { x: 0, y: 0, w: mainW - gap, h: H };
    const h = (H - gap * (others.length - 1)) / others.length;
    others.forEach((i, k) => { cells[i] = { x: mainW, y: k * (h + gap), w: W - mainW, h }; });
    return cells;
  }
  if (layout === 'bottom' && n > 1) {
    // Miniaturas na proporção real da câmera, centralizadas numa faixa de 24% da altura.
    const t = tiles[others[0]];
    const stripH = Math.round(H * 0.24);
    const w = Math.min(stripH * t.w / t.h, (W - gap * (others.length - 1)) / others.length), h = w * t.h / t.w;
    const total = others.length * w + (others.length - 1) * gap;
    cells[focusIdx] = { x: 0, y: 0, w: W, h: H - stripH - gap };
    others.forEach((i, k) => { cells[i] = { x: (W - total) / 2 + k * (w + gap), y: H - h, w, h }; });
    return cells;
  }
  if (layout === 'pip' && n > 1) {
    cells[focusIdx] = { x: 0, y: 0, w: W, h: H };
    const margin = Math.round(12 * devicePixelRatio);
    const w = Math.min(W * 0.2, (W - margin * 2 - gap * (others.length - 1)) / others.length);
    const t = tiles[others[0]], h = w * t.h / t.w;
    const total = others.length * w + (others.length - 1) * gap;
    others.forEach((i, k) => { cells[i] = { x: W - margin - total + k * (w + gap), y: H - margin - h, w, h }; });
    return cells;
  }
  const cols = n === 4 ? 2 : n, rows = n === 4 ? 2 : 1;
  const w = (W - gap * (cols - 1)) / cols, h = (H - gap * (rows - 1)) / rows;
  return [...Array(n).keys()].map((i) => ({ x: (i % cols) * (w + gap), y: Math.floor(i / cols) * (h + gap), w, h }));
}

function label(text, x, y, strong) {
  const dpr = devicePixelRatio;
  ctx.font = `${strong ? 600 : 500} ${12 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const pad = 6 * dpr, tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(10,12,16,.72)';
  ctx.fillRect(x, y, tw + pad * 2, 20 * dpr);
  ctx.fillStyle = strong ? '#ffd166' : '#e8ecf3';
  ctx.fillText(text, x + pad, y + 14 * dpr);
}

function draw() {
  requestAnimationFrame(draw);
  if (ui.mode !== 'merge') return;
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, W, H);
  const v = $('#video');
  if (!geometry || !geometry.tiles || v.readyState < 2 || !v.videoWidth) {
    ctx.fillStyle = '#7c869a'; ctx.font = `${14 * dpr}px system-ui`;
    ctx.fillText('aguardando o primeiro segmento mergeado…', 20 * dpr, 34 * dpr);
    return;
  }
  const n = geometry.tiles.length;
  if (ui.layout === 'raw') {
    const d = fit(v.videoWidth, v.videoHeight, { x: 0, y: 0, w: W, h: H });
    ctx.drawImage(v, d.x, d.y, d.w, d.h);
    const s = d.w / v.videoWidth;
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([8 * dpr, 6 * dpr]);
    geometry.tiles.forEach((t, i) => {
      ctx.strokeRect(d.x + t.x * s, d.y + t.y * s, t.w * s, t.h * s);
      label(`tile ${i} = CAM ${geometry.cams[i]}`, d.x + t.x * s + 8 * dpr, d.y + t.y * s + 8 * dpr, true);
    });
    ctx.setLineDash([]);
    label(`1 frame decodificado: ${v.videoWidth}x${v.videoHeight}`, d.x + 8 * dpr, d.y + d.h - 28 * dpr, false);
    lastCells = [];
    return;
  }
  const focusIdx = Math.max(0, geometry.cams.indexOf(ui.focusCam ?? geometry.cams[0]));
  const cells = cellsFor(ui.layout, geometry.tiles, W, H, focusIdx);
  const hasMain = ui.layout !== 'grid' && n > 1;
  lastCells = [];
  // A câmera principal é desenhada primeiro: no layout de miniaturas elas ficam por cima.
  const order = [focusIdx, ...geometry.tiles.keys()].filter((i, k, a) => a.indexOf(i) === k);
  for (const i of order) {
    const t = geometry.tiles[i];
    const d = fit(t.w, t.h, cells[i]);
    ctx.drawImage(v, t.x, t.y, t.w, t.h, d.x, d.y, d.w, d.h);
    if (ui.layout === 'pip' && i !== focusIdx) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2 * dpr; ctx.strokeRect(d.x, d.y, d.w, d.h);
    }
    label(`CAM ${geometry.cams[i]}`, d.x + 8 * dpr, d.y + 8 * dpr, hasMain && i === focusIdx);
    lastCells.push({ ...d, cam: geometry.cams[i] });
  }
}
requestAnimationFrame(draw);

canvas.addEventListener('click', (ev) => {
  if (ui.layout === 'grid' || ui.layout === 'raw') return;
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio;
  const x = (ev.clientX - r.left) * dpr, y = (ev.clientY - r.top) * dpr;
  const hit = lastCells.findLast((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  if (hit && hit.cam !== ui.focusCam) { ui.focusCam = hit.cam; log(`destaque: CAM ${hit.cam} (só o render mudou; nada foi baixado ou decodificado de novo)`); }
});

// ---------------------------------------------------------------- painel
function kv(el, rows) {
  el.innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
}

function tick() {
  const ps = session ? session.players : [];
  const videos = ps.map((p) => p.video);
  let decoded = 0, dropped = 0;
  for (const v of videos) {
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    if (q) { decoded += q.totalVideoFrames; dropped += q.droppedVideoFrames; }
  }
  const lat = ps.map((p) => p.player.getStats().liveLatency).filter((x) => Number.isFinite(x) && x > 0);
  const res = [...new Set(videos.map((v) => (v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '—')))];
  const nDec = ps.length;
  kv($('#kvDecode'), [
    ['Players Shaka', nDec || '—', nDec === 1 ? 'good' : nDec > 1 ? 'warn' : ''],
    ['Streams de vídeo no MSE', nDec ? `${nDec} (1 SourceBuffer por player)` : '—', nDec === 1 ? 'good' : nDec > 1 ? 'warn' : ''],
    ['Resolução decodificada', res.join(', ') || '—'],
    ['Frames decodificados', decoded ? decoded.toLocaleString('pt-BR') : '—'],
    ['Frames descartados', decoded ? dropped.toLocaleString('pt-BR') : '—', dropped > 0 ? 'warn' : ''],
    ['Latência ao vivo', lat.length ? `${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1)} s` : '—'],
    ['Codec', codecs],
  ]);
  if (ui.mode === 'merge') {
    kv($('#kvMerge'), [
      ['Tiles no canvas', geometry && geometry.tiles ? `${geometry.tiles.length} (${geometry.cams.map((c) => 'CAM ' + c).join(' · ')})` : '—'],
      ['Segmentos mergeados', merge.segments || '—'],
      ['Tempo de merge', merge.segments ? `${(merge.ms / merge.segments).toFixed(1)} ms médio · último ${merge.lastMs.toFixed(1)} ms` : '—'],
      ['Bytes', merge.segments ? `${fmtBytes(merge.bytesIn)} → ${fmtBytes(merge.bytesOut)}` : '—'],
      ['Último segmento', merge.last ?? '—'],
    ]);
  } else {
    kv($('#kvMerge'), [['Merge', 'desligado neste modo: cada câmera vai para o seu próprio decoder']]);
  }
  $('#decodedRes').textContent = videos[0] && ui.mode === 'merge' && videos[0].videoWidth ? `1 frame ${videos[0].videoWidth}x${videos[0].videoHeight}` : '—';
  const pills = [
    [`Shaka ${shaka.Player.version}`, ''],
    [hevcOk ? 'HEVC no MSE ✓' : 'HEVC no MSE ✗', hevcOk ? 'good' : 'bad'],
    [ui.mode === 'merge' ? `${nDec || 0} decoder` : `${nDec} decoders`, ui.mode === 'merge' ? 'good' : 'warn'],
  ];
  $('#pills').innerHTML = pills.map(([t, c]) => `<span class="pill ${c}">${t}</span>`).join('');
}
const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} kB`);
setInterval(tick, 500);

// ---------------------------------------------------------------- controles
function setOn(group, attr, value) {
  for (const b of document.querySelectorAll(`${group} button`)) b.classList.toggle('on', b.dataset[attr] === value);
}
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => { if (ui.mode === b.dataset.mode) return; ui.mode = b.dataset.mode; setOn('.controls .seg:first-child', 'mode', ui.mode); start(); });
}
function setLayout(layout) {
  ui.layout = layout;
  for (const b of document.querySelectorAll('#layoutMenu [data-layout]')) {
    const on = b.dataset.layout === layout;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  }
  $('#layoutName').textContent = LAYOUT_NAMES[layout];
  try { localStorage.setItem('mv.layout', layout); } catch { /* sem storage: só não lembra */ }
}
function toggleMenu(open) {
  $('#layoutMenu').hidden = !open;
  $('#layoutBtn').setAttribute('aria-expanded', String(open));
}
$('#layoutBtn').addEventListener('click', () => toggleMenu($('#layoutMenu').hidden));
for (const b of document.querySelectorAll('#layoutMenu [data-layout]')) {
  b.addEventListener('click', () => { setLayout(b.dataset.layout); toggleMenu(false); });
}
document.addEventListener('click', (e) => { if (!e.target.closest('#layoutCtl')) toggleMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMenu(false); });
setLayout(ui.layout);
$('#cams').value = ui.cams;
$('#cams').addEventListener('change', (e) => { ui.cams = e.target.value; start(); });
setOn('.controls .seg:first-child', 'mode', ui.mode);

log(`MPD do servidor: <code>${MPD}</code>`);
start();

// Para inspeção no console.
window.mv = { get session() { return session; }, get geometry() { return geometry; }, set geometry(g) { geometry = g; }, scheme, merge };
