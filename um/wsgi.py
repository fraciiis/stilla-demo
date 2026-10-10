"""Adattatore WSGI per i servizi «serverless» (Vercel e simili): ogni richiesta passa allo stesso Handler del server locale.

Niente da installare: solo libreria standard. Le sessioni restano nella memoria dell'istanza; se l'istanza riparte,
il browser ricarica da solo la sorgente (esempio, campo dimostrativo o file) e ripete la richiesta (vedi static/js/api.js).
"""

from __future__ import annotations

import io
import urllib.parse
from typing import Any, Callable, Iterable

from .server import Handler

_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
        "transfer-encoding", "upgrade"}


class _Server:
    server_address = ("0.0.0.0", 443)


def _target(environ: dict[str, Any]) -> str:
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if raw:
        return raw
    path = urllib.parse.quote(environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "/"), safe="/:@!$&'()*+,;=-._~%")
    qs = environ.get("QUERY_STRING")
    return path + ("?" + qs if qs else "")


def app(environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
    method = environ.get("REQUEST_METHOD", "GET").upper()
    stream = environ.get("wsgi.input")
    length = environ.get("CONTENT_LENGTH") or ""
    if length.strip().isdigit():
        body = stream.read(int(length)) if stream and int(length) else b""
    else:
        body = stream.read() if stream and method in ("POST", "PUT") else b""
    headers = [(k[5:].replace("_", "-").title(), v) for k, v in environ.items() if k.startswith("HTTP_")]
    headers = [(k, v) for k, v in headers if k.lower() not in ("content-length", "transfer-encoding")]
    if environ.get("CONTENT_TYPE"):
        headers.append(("Content-Type", environ["CONTENT_TYPE"]))
    headers.append(("Content-Length", str(len(body))))
    head = f"{method} {_target(environ)} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers) + "\r\n"

    h = Handler.__new__(Handler)
    h.rfile = io.BytesIO(head.encode("latin-1", "replace") + body)
    h.wfile = io.BytesIO()
    h.client_address = (environ.get("REMOTE_ADDR") or "0.0.0.0", 0)
    h.server = _Server()                                      # type: ignore[assignment]
    h.request = None                                          # type: ignore[assignment]
    h.close_connection = True
    h.handle_one_request()

    raw = h.wfile.getvalue()
    top, _, payload = raw.partition(b"\r\n\r\n")
    lines = top.decode("latin-1").split("\r\n")
    status = lines[0].split(" ", 1)[1] if lines and " " in lines[0] else "500 Internal Server Error"
    out = []
    for line in lines[1:]:
        k, _, v = line.partition(":")
        if k and k.strip().lower() not in _HOP:
            out.append((k.strip(), v.strip()))
    start_response(status, out)
    return [payload]
