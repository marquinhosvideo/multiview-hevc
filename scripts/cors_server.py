#!/usr/bin/env python3
"""Servidor estático para o HLS de teste: CORS aberto e sem cache.

uso: cors_server.py <porta> <diretório>
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4', '.ts': 'video/mp2t'}

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port, root = int(sys.argv[1]), sys.argv[2]
    http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root)).serve_forever()
