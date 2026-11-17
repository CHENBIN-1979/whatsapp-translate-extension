#!/usr/bin/env python3
# v1.1.27 e2e mock：OpenAI 兼容 /chat/completions。
# 行为：对含 DARIMINTO 的中文句，首轮返回原文（模拟模型被专名带偏回显），
# 第二次（重试，sys 含「绝不能整句原样返回」）返回印尼文译文。
# 纯人名/纯号码始终返回原文（回显）。计数 /hits，重置 /hits?reset=1。
import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import defaultdict

lock = threading.Lock()
hits = defaultdict(int)   # text -> call count
total = [0]

def reply_text(text, sys):
    is_retry = '绝不能整句原样返回' in sys
    if 'DARIMINTO' in text:
        return text if not is_retry else 'DARIMINTO, silakan cek sekarang apakah bisa diperbaiki'
    # 纯人名/号码/普通：始终原样（回显）—— 仅 DARIMINTO 句用于测重试
    return text

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()
    def do_GET(self):
        if self.path.startswith('/hits'):
            if 'reset' in self.path:
                with lock:
                    hits.clear(); total[0] = 0
                self._send(200, {'reset': True}); return
            with lock:
                self._send(200, {'total': total[0], 'per': dict(hits)})
            return
        self._send(404, {'e': 'nf'})
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        msgs = body.get('messages', [])
        sys = msgs[0]['content'] if msgs else ''
        user = msgs[1]['content'] if len(msgs) > 1 else ''
        try:
            items = json.loads(user) if user.strip().startswith('[') else [user]
            is_batch = user.strip().startswith('[')
        except Exception:
            items, is_batch = [user], False
        with lock:
            total[0] += 1
            for t in items:
                hits[t] += 1
        out = [reply_text(t, sys) for t in items]
        content = json.dumps(out) if is_batch else out[0]
        self._send(200, {'choices': [{'message': {'content': content}}]})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8791), H).serve_forever()
