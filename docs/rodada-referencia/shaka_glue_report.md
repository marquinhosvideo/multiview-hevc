# Prova ao vivo: o plugin mv:// do Shaka (web/mv-shaka.js) entrega segmentos que reconstroem as câmeras

Gerado em 2026-10-30 20:45:00. Gravação: 2048x1152, 240 frames, decodificada uma única vez.

| Posição no canvas | Câmera identificada | Frames idênticos à fonte | Resultado |
|---|---|---|---|
| 0,0 | cam1 | 240/240 | ✅ bit-exact |
| 1024,0 | cam2 | 240/240 | ✅ bit-exact |
| 0,576 | cam3 | 240/240 | ✅ bit-exact |
| 1024,576 | cam4 | 240/240 | ✅ bit-exact |

**Resultado: PASSOU.** Todos os frames de todas as posições batem bit a bit com a câmera de origem.
