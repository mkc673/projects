#!/usr/bin/env python3
"""Local dev server for sim/ with Cache-Control: no-store so reloads never serve stale JS/WASM."""

import http.server
import os
import socketserver

PORT = 8000
SIM_DIR = os.path.dirname(os.path.abspath(__file__))


class NoCacheRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SIM_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with ReusableTCPServer(("127.0.0.1", PORT), NoCacheRequestHandler) as httpd:
        print(f"Serving sim/ (no-cache) at http://127.0.0.1:{PORT}/", flush=True)
        httpd.serve_forever()
