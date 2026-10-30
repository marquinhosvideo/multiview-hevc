# Prova ao vivo: o bitstream mergeado no cliente reconstrói as câmeras

Gerado em 2026-10-30 20:19:23. Gravação: 2048x1152, 648 frames, decodificada uma única vez.

| Posição no canvas | Câmera identificada | Frames idênticos à fonte | Resultado |
|---|---|---|---|
| 0,0 | cam1 | 648/648 | ✅ bit-exact |
| 1024,0 | cam3 | 648/648 | ✅ bit-exact |
| 0,576 | cam2 | 648/648 | ✅ bit-exact |
| 1024,576 | cam4 | 648/648 | ✅ bit-exact |

**Resultado: PASSOU.** Todos os frames de todas as posições batem bit a bit com a câmera de origem.
