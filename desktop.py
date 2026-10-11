#!/usr/bin/env python3
"""
Desktop entry point for the packaged Mac / Windows app.

Starts the local Flask server on a free port and shows the UI in a native
window (pywebview). If a native window can't be created, falls back to the
default web browser. Closing the window quits the app.

Run from source:  python3 desktop.py      (server only:  python3 app.py)
"""

from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

# PyInstaller --windowed on Windows has no console: stdout/stderr are None
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

from werkzeug.serving import make_server

from app import DATA, app
from version import APP_NAME, __version__

PREFERRED_PORT = 5100  # Seamless Texture Maker links here


def _setup_logging() -> logging.Logger:
    log_path = DATA / "app.log"
    try:
        if log_path.exists() and log_path.stat().st_size > 2_000_000:
            log_path.unlink()
    except OSError:
        pass
    logging.basicConfig(
        filename=str(log_path),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    return logging.getLogger("tmm")


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _already_running(port: int) -> bool:
    """Is our own app already serving on this port?"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.6) as r:
            return APP_NAME.encode() in r.read()
    except Exception:
        return False


def _pick_port() -> int:
    if _port_free(PREFERRED_PORT):
        return PREFERRED_PORT
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerThread(threading.Thread):
    def __init__(self, port: int):
        super().__init__(daemon=True)
        self.server = make_server("127.0.0.1", port, app, threaded=True)

    def run(self):
        self.server.serve_forever()

    def shutdown(self):
        self.server.shutdown()


def _wait_until_up(url: str, timeout: float = 15.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url + "/health", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def _open_native_window(url: str, log: logging.Logger) -> bool:
    """Returns True if a native window was shown (and has now been closed)."""
    if os.environ.get("TMM_BROWSER") == "1":
        return False
    try:
        import webview  # pywebview
    except Exception:
        log.info("pywebview not available — using browser")
        return False
    try:
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True  # ZIP + "Save this map"
            webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        except Exception:
            pass
        webview.create_window(
            f"{APP_NAME} {__version__}",
            url,
            width=1380,
            height=920,
            min_size=(900, 640),
            background_color="#0a0f0c",
        )
        webview.start()
        return True
    except Exception:
        log.error("native window failed:\n%s", traceback.format_exc())
        return False


def smoke_test() -> int:
    """Used by the build pipeline: proves the packaged app can serve the UI,
    the bundled 3D library, and generate seamless maps — without a window."""
    import io

    import numpy as np
    from PIL import Image

    c = app.test_client()
    ok = True
    lines = []

    def say(*a):  # also saved to a file — the Windows GUI exe has no console
        lines.append(" ".join(str(x) for x in a))
        print(*a)

    for path, needle in [
        ("/health", b"ok"),
        ("/", b"Seamless"),
        ("/static/vendor/three/three.module.min.js", b"REVISION"),
        ("/static/vendor/three/addons/controls/OrbitControls.js", b"OrbitControls"),
    ]:
        r = c.get(path)
        good = r.status_code == 200 and needle in r.data
        say(("PASS " if good else "FAIL ") + path)
        ok &= good
    rng = np.random.default_rng(1)
    img = (rng.random((96, 128, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    buf.seek(0)
    r = c.post(
        "/api/generate",
        data={"diffuse": (buf, "t.png"), "seamless": "true", "seamless_method": "smart"},
        content_type="multipart/form-data",
    )
    maps = (r.get_json() or {}).get("maps", {})
    good = r.status_code == 200 and maps.get("seamless") and "normal" in maps
    say(("PASS " if good else "FAIL ") + f"generate seamless maps {maps.get('seam_after')}")
    ok &= bool(good)
    say("SMOKE TEST", "OK" if ok else "FAILED")
    try:
        (DATA / "smoke-test.txt").write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass
    return 0 if ok else 1


def main() -> None:
    if "--smoke-test" in sys.argv:
        sys.exit(smoke_test())
    log = _setup_logging()
    log.info("starting %s %s (data: %s)", APP_NAME, __version__, DATA)

    # second launch while already open → just show it in the browser
    if not _port_free(PREFERRED_PORT) and _already_running(PREFERRED_PORT):
        webbrowser.open(f"http://127.0.0.1:{PREFERRED_PORT}/")
        return

    port = _pick_port()
    url = f"http://127.0.0.1:{port}"
    server = ServerThread(port)
    server.start()
    if not _wait_until_up(url):
        log.error("server did not start on %s", url)

    if _open_native_window(url + "/", log):
        server.shutdown()  # window closed → quit
        return

    # Fallback: browser tab; keep serving until the process is quit
    webbrowser.open(url + "/")
    print(f"{APP_NAME} running at {url}  (Ctrl+C to quit)")
    try:
        while server.is_alive():
            server.join(1)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
