#!/usr/bin/env python3
"""Servidor da página do player (web/) com um proxy local para o HLS.

O navegador bloqueia HLS de outro domínio quando o servidor de origem não
envia CORS (caso comum em encoders e CDNs). O proxy resolve: a página pede
/proxy?url=<URL do HLS> a este servidor, que busca a URL e devolve os bytes na
mesma origem. Como roda na sua máquina, alcança também o que só a sua rede/VPN
enxerga.

uso: web_server.py <porta> <diretório>

Segurança: escuta só em 127.0.0.1, aceita só http(s), e recusa pedidos cujo
Host ou Origin não seja local (protege contra DNS rebinding e contra outras
páginas usando o proxy). Usa o curl do sistema, que confia nos certificados do
macOS (o Python da Apple costuma não confiar).
"""
import functools
import http.server
import subprocess
import sys
import urllib.parse

LOCAL = ('127.0.0.1', 'localhost', '[::1]')


def is_local(value):
    if not value:
        return True
    host = urllib.parse.urlsplit(value if '//' in value else '//' + value).hostname or ''
    return host in ('127.0.0.1', 'localhost', '::1')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.m3u8': 'application/vnd.apple.mpegurl'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    def reply(self, status, body=b'', ctype='text/plain; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.path.startswith('/proxy'):
            return super().do_GET()
        if not is_local(self.headers.get('Host')) or not is_local(self.headers.get('Origin')):
            return self.reply(403, b'proxy so aceita pedidos locais')
        target = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('url', [''])[0]
        if not target:
            return self.reply(400, b'falta ?url=')  # tambem serve de teste: o proxy existe
        if urllib.parse.urlsplit(target).scheme not in ('http', 'https'):
            return self.reply(400, b'so http e https')
        try:
            out = subprocess.run(
                ['curl', '-sS', '-L', '--max-time', '30', '--proto', '=http,https', '-A', 'multiview-hevc-proxy',
                 '-o', '-', '-w', '\n%{http_code} %{content_type}', '--', target],
                capture_output=True, timeout=40)
        except Exception as e:  # curl ausente, timeout...
            return self.reply(502, f'falha ao executar o curl: {e}'.encode())
        if out.returncode != 0:
            return self.reply(502, (out.stderr.decode(errors='replace').strip() or 'curl falhou').encode())
        body, _, trailer = out.stdout.rpartition(b'\n')
        code, _, ctype = trailer.decode(errors='replace').partition(' ')
        self.reply(int(code) if code.isdigit() else 502, body, ctype or 'application/octet-stream')


if __name__ == '__main__':
    port, root = int(sys.argv[1]), sys.argv[2]
    http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root)).serve_forever()
