// Página de entrada HLS: cola as 4 URLs, diagnostica e abre o player.
import { diagnose } from './hls-check.js';
import { fetchBytes } from './mv-shaka.js';

const $ = (s) => document.querySelector(s);
const inputs = [1, 2, 3, 4].map((n) => document.querySelector(`[name="u${n}"]`));
const params = new URLSearchParams(location.search);

// ---- proxy local (contorna CORS): existe só no servidor do projeto (make web)
let proxyOk = false;
try { proxyOk = (await fetch('/proxy', { cache: 'no-store' })).status === 400; } catch { /* sem servidor local */ }
const proxyBox = $('#proxy');
proxyBox.disabled = !proxyOk;
$('#proxyNote').textContent = proxyOk
  ? '(contorna CORS e alcança o que só a sua rede/VPN enxerga)'
  : '(indisponível: abra a página por make web-hls)';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } },
};
proxyBox.checked = proxyOk && store.get('mv.proxy', true);
proxyBox.addEventListener('change', () => { store.set('mv.proxy', proxyBox.checked); invalidate(); });

const fetcher = () => (proxyBox.checked ? (u) => fetchBytes(`/proxy?url=${encodeURIComponent(u)}`) : fetchBytes);

// ---- preenchimento
const saved = store.get('mv.hls', ['', '', '', '']);
const fromUrl = (params.get('hls') || '').split(',').map((x) => x.trim()).filter(Boolean);
(fromUrl.length === 4 ? fromUrl : saved).forEach((u, i) => { inputs[i].value = u; });

const splitUrls = (text) => text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x));
for (const inp of inputs) {
  inp.addEventListener('paste', (e) => {
    const urls = splitUrls(e.clipboardData.getData('text'));
    if (urls.length < 2) return;
    e.preventDefault();
    const start = inputs.indexOf(inp);
    urls.slice(0, 4 - start).forEach((u, k) => { inputs[start + k].value = u; });
    invalidate();
  });
  inp.addEventListener('input', invalidate);
}
$('#fillLocal').addEventListener('click', () => {
  inputs.forEach((inp, i) => { inp.value = `http://127.0.0.1:8082/cam${i + 1}/index.m3u8`; });
  invalidate();
});

// ---- diagnóstico
const playBtn = $('#play'), checkBtn = $('#check');
let verified = null;
function invalidate() { verified = null; playBtn.disabled = true; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON = { ok: '✔', warn: '!', bad: '✘' };

function explain(err) {
  const m = String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return proxyBox.checked
      ? 'O servidor local não conseguiu buscar a URL. Confira se ela abre no navegador e se a VPN/rede está ativa.'
      : 'O navegador não conseguiu buscar a URL: provavelmente falta CORS no servidor dos streams. Marque "Passar pelo servidor local" (abra a página por <code>make web-hls</code>).';
  }
  return esc(m);
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urls = inputs.map((i) => i.value.trim());
  store.set('mv.hls', urls);
  $('#result').hidden = false;
  $('#camTable').innerHTML = ''; $('#checks').innerHTML = ''; $('#verdict').className = 'verdict'; $('#verdict').innerHTML = '';
  $('#status').className = 'status busy'; $('#status').textContent = 'Lendo as playlists e costurando os últimos segmentos…';
  checkBtn.disabled = true; invalidate();

  let d;
  try { d = await diagnose(urls, { fetchBytes: fetcher(), segments: 3 }); }
  catch (err) { d = { ok: false, checks: [{ kind: 'bad', msg: String(err && err.message || err) }] }; }
  checkBtn.disabled = false;
  $('#status').className = 'status';

  if (d.canvas) {
    $('#status').textContent = `Canvas ${d.canvas.width}×${d.canvas.height} (grade ${d.canvas.grid.cols}×${d.canvas.grid.rows}) · pareamento por ${d.info.mode === 'pdt' ? 'EXT-X-PROGRAM-DATE-TIME' : 'número de sequência'} · ${d.info.slots} segmentos em comum · ${d.info.live ? 'ao vivo' : 'VOD'}`;
    $('#camTable').innerHTML = `<tr><th>cam</th><th>container</th><th>perfil / nível</th><th>tile</th><th>CTU</th><th>TMVP</th><th>codec</th></tr>` +
      d.cams.map((c) => `<tr><td>${c.index}</td><td>${c.container}</td><td>${c.profile} / ${c.level.toFixed(1)}</td><td>${c.width}×${c.height}</td><td>${c.ctb}</td>` +
        `<td class="${c.tmvp ? 'warn' : 'good'}">${c.tmvp ? 'ligado' : 'desligado'}</td><td>${esc(c.codec)}</td></tr>`).join('');
  } else $('#status').textContent = 'Não consegui ler os streams.';
  $('#checks').innerHTML = d.checks.map((c) => `<li><span class="${c.kind}">${ICON[c.kind]}</span><span>${c.kind === 'bad' && !d.canvas ? explain(c.msg) : esc(c.msg)}</span></li>`).join('');

  const v = $('#verdict');
  if (!d.canvas || d.checks.some((c) => c.kind === 'bad')) {
    v.className = 'verdict bad';
    v.innerHTML = '<strong>Não dá para costurar estes streams como estão.</strong> Corrija os itens ✘ no encoder ou recodifique antes de publicar (<code>scripts/02_encode.sh</code> mostra o perfil).';
    return;
  }
  verified = { urls, proxy: proxyBox.checked };
  playBtn.disabled = false;
  const tmvp = d.cams.some((c) => c.tmvp);
  v.className = `verdict ${tmvp ? 'warn' : 'good'}`;
  v.innerHTML = `<strong>Estruturalmente mergeável.</strong> ` +
    (tmvp ? 'Mas há TMVP ligado: o merge pode sair com imagem errada junto às bordas dos tiles, sem acusar erro. ' : 'O SPS não tem TMVP. ') +
    'Esta página não decodifica o vídeo, então não prova que os vetores de movimento respeitam as bordas. Duas formas de confirmar: ' +
    '<strong>toque o multiview</strong> e procure borrões ou "fantasmas" nas emendas (use o layout <em>Frame decodificado</em>), ou rode a prova bit a bit: <br>' +
    `<code>make check-hls HLS="${esc(urls.join(' '))}"</code>`;
});

playBtn.addEventListener('click', () => {
  const urls = inputs.map((i) => i.value.trim());
  const q = new URLSearchParams({ hls: urls.join(','), proxy: proxyBox.checked ? '1' : '0' });
  location.href = `index.html?${q}`;
});
