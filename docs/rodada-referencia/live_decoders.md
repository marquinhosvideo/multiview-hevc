# Prova ao vivo: quantos decoders o cliente abre

Gerado em 2026-10-30 20:18:56 em Linux x86_64. Câmeras: 1,2,3,4. Fonte: `http://127.0.0.1:8080/live.mpd`

| Rodada | Streams baixados | Instâncias de decoder | Decoders |
|---|---|---|---|
| A. Sem merge | 4 | **4** | ffdec x4  |
| B. Com merge (hevcmerge) | 4 | **1** | ffdec x1  |

## Grafo da rodada B (com merge)
```
Filters connected:
httpin (src=http://127.0.0.1:8080/live.mpd:gpac:init_timeshift=6000:debug_as=0,1,2,3) (idx=1)
-(PID live.mpd) dashin (dyn_idx=5)
--(PID AS1)\
--(PID AS2) \
--(PID AS3)  \
--(PID AS4)---> hevcmerge (idx=2)
---(PID AS1) reframer (rt=on) (idx=3)
----(PID AS1) ffdec "ffdec:hevc (3 threads)" (dyn_idx=14)
-----(PID AS1) writegen (dyn_idx=15)
------(PID AS1) fout (dst=/dev/null:ext=yuv) (idx=4)
httpin (src=http://127.0.0.1:8080/cam1/seg_init.mp4:gpac:cache=mem_keep) (idx=6)
-(PID seg_20.m4s) mp4dmx (dyn_idx=10)
--(PID seg_init.mp4) dashin (dyn_idx=5)
httpin (src=http://127.0.0.1:8080/cam2/seg_init.mp4:gpac:cache=mem_keep) (idx=7)
-(PID seg_20.m4s) mp4dmx (dyn_idx=11)
--(PID seg_init.mp4) dashin (dyn_idx=5)
httpin (src=http://127.0.0.1:8080/cam3/seg_init.mp4:gpac:cache=mem_keep) (idx=8)
-(PID seg_20.m4s) mp4dmx (dyn_idx=12)
--(PID seg_init.mp4) dashin (dyn_idx=5)
```

## Grafo da rodada A (sem merge)
```
Filters connected:
httpin (src=http://127.0.0.1:8080/live.mpd:gpac:init_timeshift=6000:debug_as=0,1,2,3) (idx=1)
-(PID live.mpd) dashin (dyn_idx=4)
--(PID AS1)\
--(PID AS2) \
--(PID AS3)  \
--(PID AS4)---> reframer (rt=on) (idx=2)
---(PID AS1) ffdec "ffdec:hevc (3 threads)" (dyn_idx=13)
----(PID AS1) writegen (dyn_idx=14)
-----(PID AS1) fout (dst=/dev/null:ext=yuv) (idx=3)
---(PID AS2) ffdec "ffdec:hevc (3 threads)" (dyn_idx=15)
----(PID AS2) writegen (dyn_idx=16)
-----(PID AS2) fout (dst=/dev/null:ext=yuv:rt=on:ext=yuv) (idx=21)
---(PID AS3) ffdec "ffdec:hevc (3 threads)" (dyn_idx=17)
----(PID AS3) writegen (dyn_idx=18)
-----(PID AS3) fout (dst=/dev/null:ext=yuv:rt=on:ext=yuv) (idx=22)
---(PID AS4) ffdec "ffdec:hevc (3 threads)" (dyn_idx=19)
----(PID AS4) writegen (dyn_idx=20)
-----(PID AS4) fout (dst=/dev/null:ext=yuv:rt=on:ext=yuv) (idx=23)
httpin (src=http://127.0.0.1:8080/cam1/seg_init.mp4:gpac:cache=mem_keep) (idx=5)
```
