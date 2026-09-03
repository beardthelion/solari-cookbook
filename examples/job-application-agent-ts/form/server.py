#!/usr/bin/env python3
"""Safe-target application form server (KTD2) for the job-application-agent example.

Serves the ATS-shaped form from form/index.html on GET and, on POST, stores
the raw urlencoded submission body to a file under submissions/ and returns a
small success page. The form and server are written into a Solari sandbox and
run backgrounded; submissions are receipts that make the pipeline's "confirm
the submission succeeded" observable without ever touching a real employer
(R9, R11).

Pure Python standard library only. Usage:
    python3 server.py <port>
Binds to 0.0.0.0 so the sandbox preview gateway can reach it on the given port.
"""
import http.server
import os
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
FORM_PATH = os.path.join(HERE, "index.html")
SUBMISSIONS_DIR = os.path.join(HERE, "submissions")
# A generous cap for a text-application POST (resume is NOT uploaded to this
# server; the pipeline stores it in the cloud browser). Keeps a hostile or
# malformed body from exhausting sandbox memory.
MAX_BODY_BYTES = 1 << 20

SUCCESS_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application received</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #f4f6f8; color: #1f2933;
         margin: 0; padding: 2rem 1rem; line-height: 1.5; }}
  main {{ max-width: 36rem; margin: 0 auto; background: #fff; border: 1px solid #d9e2ec;
         border-radius: 10px; padding: 2rem 2.5rem; }}
  h1 {{ margin: 0 0 0.5rem; font-size: 1.4rem; }}
  .ok {{ color: #1a7f37; }}
</style>
</head>
<body>
<main>
  <h1 class="ok">Application received</h1>
  <p>Thank you, <strong>{name}</strong> — your application for <strong>{role}</strong>
     has been recorded.</p>
  <p>This is a demo/sandbox form: your submission was stored inside the sandbox and was not
     sent to any real employer.</p>
</main>
</body>
</html>
"""


class FormHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            with open(FORM_PATH, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(500, "form/index.html is missing next to server.py")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            # Malformed or oversized body: refuse without reading it.
            self.close_connection = True
            self._send_text(400, "Bad Request: invalid or oversized body")
            return
        raw = self.rfile.read(length)
        # Content-Type may carry a charset; urlencoded bodies are ASCII-safe so
        # decode defensively with replacement and parse the query string.
        params = urllib.parse.parse_qs(
            raw.decode("utf-8", "replace"), keep_blank_values=True
        )
        first = lambda key: (params.get(key) or [""])[0]
        name = first("fullName").strip()
        role = first("role").strip()
        if not name or not role:
            self._send_text(400, "Bad Request: fullName and role are required")
            return
        # Raw receipt: store the exact submitted body plus a readable header.
        os.makedirs(SUBMISSIONS_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        receipt = os.path.join(SUBMISSIONS_DIR, "%s-%s.txt" % (stamp, len(raw)))
        try:
            with open(receipt, "wb") as fh:
                fh.write(raw)
        except OSError:
            self._send_text(500, "could not store the submission in the sandbox")
            return
        page = SUCCESS_TEMPLATE.format(
            name=_html_escape(name), role=_html_escape(role or "the advertised position")
        )
        self._send_text(200, page, content_type="text/html; charset=utf-8")

    def _send_text(self, status, text, content_type="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # keep the sandbox server log quiet
        pass


def _html_escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python3 server.py <port>\n")
        sys.exit(2)
    try:
        port = int(sys.argv[1])
    except ValueError:
        sys.stderr.write("port must be an integer\n")
        sys.exit(2)
    http.server.HTTPServer(("0.0.0.0", port), FormHandler).serve_forever()


if __name__ == "__main__":
    main()
