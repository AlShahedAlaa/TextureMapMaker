#!/usr/bin/env python3
"""
Texture Map Maker — free offline generator:
diffuse → normal / height / roughness (+ AO) with live specs + ZIP download.
No API keys.
"""

from __future__ import annotations

import io
import os
import secrets
import shutil
import sys
import time
import zipfile
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_file,
    send_from_directory,
    session,
)
from werkzeug.utils import secure_filename

from map_generator import generate_all_maps
from version import APP_NAME, __version__

FROZEN = getattr(sys, "frozen", False)  # True inside the packaged .app / .exe
BASE = Path(__file__).resolve().parent
# read-only bundled files (templates, static)
RES = Path(getattr(sys, "_MEIPASS", BASE))


def _user_data_dir() -> Path:
    """Where generated files live. Source checkout: next to app.py (as before).
    Packaged app: the OS's normal per-user app-data folder."""
    override = os.environ.get("TMM_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if not FROZEN:
        return BASE
    if sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        root = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return root / "TextureMapMaker"


DATA = _user_data_dir()
UPLOADS = DATA / "uploads"
OUTPUTS = DATA / "outputs"
INBOX = DATA / "inbox"
for _d in (UPLOADS, OUTPUTS, INBOX):
    _d.mkdir(parents=True, exist_ok=True)

# Seamless Texture Maker drops files here; also check it from the packaged app
INBOX_DIRS = [INBOX]
_legacy_inbox = Path.home() / "Desktop" / "TextureMapMaker" / "inbox"
if _legacy_inbox.resolve() != INBOX.resolve():
    INBOX_DIRS.append(_legacy_inbox)


def _cleanup_old_outputs(max_age_days: float = 7.0) -> None:
    """Session folders pile up over time — drop ones untouched for a week."""
    cutoff = time.time() - max_age_days * 86400
    for d in OUTPUTS.iterdir():
        if d.is_dir() and d.name != "selftest":
            try:
                if d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass


_cleanup_old_outputs()

app = Flask(
    __name__,
    template_folder=str(RES / "templates"),
    static_folder=str(RES / "static"),
)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(16)
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024  # 80 MB

ALLOWED = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _session_dir() -> Path:
    sid = session.get("sid")
    if not sid:
        import uuid

        sid = uuid.uuid4().hex[:12]
        session["sid"] = sid
    d = OUTPUTS / sid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _parse_bool(val, default=False) -> bool:
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    return str(val).lower() in ("1", "true", "yes", "on")


def _params_from_request() -> dict:
    f = request.form
    return {
        "height_strength": float(f.get("height_strength", 1.0)),
        "height_blur": float(f.get("height_blur", 0.5)),
        "height_contrast": float(f.get("height_contrast", 1.0)),
        "height_invert": _parse_bool(f.get("height_invert"), False),
        "height_level": float(f.get("height_level", 0.0)),
        "normal_strength": float(f.get("normal_strength", 2.0)),
        "normal_blur": float(f.get("normal_blur", 0.0)),
        "normal_invert_x": _parse_bool(f.get("normal_invert_x"), False),
        "normal_invert_y": _parse_bool(f.get("normal_invert_y"), True),
        "roughness_method": f.get("roughness_method") or "variance",
        "roughness_strength": float(f.get("roughness_strength", 1.0)),
        "roughness_blur": float(f.get("roughness_blur", 1.5)),
        "roughness_contrast": float(f.get("roughness_contrast", 1.0)),
        "roughness_invert": _parse_bool(f.get("roughness_invert"), False),
        "roughness_base": float(f.get("roughness_base", 0.5)),
        "include_ao": _parse_bool(f.get("include_ao"), True),
        "ao_strength": float(f.get("ao_strength", 1.0)),
        "ao_blur": float(f.get("ao_blur", 2.0)),
        "max_size": int(f.get("max_size") or 2048),
        "seamless": _parse_bool(f.get("seamless"), False),
        "seamless_method": f.get("seamless_method") or "smart",
        "seamless_blend": float(f.get("seamless_blend", 0.25)),
        "seamless_equalize": float(f.get("seamless_equalize", 0.0)),
        "tileable": _parse_bool(f.get("tileable"), False),
    }


@app.route("/")
def index():
    return render_template("index.html", version=__version__)


@app.route("/api/generate", methods=["POST"])
def api_generate():
    out_dir = _session_dir()
    uploaded = False

    file = request.files.get("diffuse")
    if file and file.filename:
        ext = Path(secure_filename(file.filename)).suffix.lower()
        if ext not in ALLOWED:
            return jsonify({"error": f"Unsupported format {ext}"}), 400
        raw = out_dir / f"upload{ext or '.png'}"
        file.save(raw)
        diffuse_path = raw
        uploaded = True
        # remember path for this session
        session["diffuse_name"] = raw.name
    else:
        # reuse last upload (live slider updates — no re-upload)
        name = session.get("diffuse_name")
        candidate = out_dir / name if name else None
        if candidate and candidate.exists():
            diffuse_path = candidate
        else:
            uploads = sorted(out_dir.glob("upload.*"), key=lambda p: p.stat().st_mtime, reverse=True)
            if uploads:
                diffuse_path = uploads[0]
                session["diffuse_name"] = diffuse_path.name
            elif (out_dir / "diffuse.png").exists():
                diffuse_path = out_dir / "diffuse.png"
            else:
                return jsonify({"error": "Upload a diffuse texture first"}), 400

    try:
        params = _params_from_request()
        # live preview flag already lowers max_size from client
        maps = generate_all_maps(diffuse_path, out_dir, **params)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    sid = session.get("sid")
    previews = {
        k: f"/outputs/{sid}/{v}"
        for k, v in maps.items()
        if k in ("diffuse", "height", "normal", "roughness", "ao") and isinstance(v, str)
    }
    return jsonify(
        {
            "ok": True,
            "maps": maps,
            "previews": previews,
            "uploaded": uploaded,
            "download_zip": "/api/download-zip",
        }
    )


@app.route("/api/download-zip")
def download_zip():
    out_dir = _session_dir()
    names = ["diffuse.png", "normal.png", "height.png", "roughness.png", "ao.png"]
    existing = [n for n in names if (out_dir / n).exists()]
    if not existing:
        return jsonify({"error": "Generate maps first"}), 400

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in existing:
            zf.write(out_dir / n, arcname=n)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name="pbr_textures.zip",
    )


@app.route("/outputs/<sid>/<path:filename>")
def serve_output(sid, filename):
    return send_from_directory(OUTPUTS / sid, filename)


@app.route("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "app": APP_NAME,
            "version": __version__,
            "free": True,
            "api_key_required": False,
        }
    )


@app.route("/api/import-inbox", methods=["POST", "GET"])
def import_inbox():
    """
    Load diffuse from inbox/ (written by Seamless Texture Maker).
    Generates maps with default params and clears the pending flag.
    """
    candidates = [
        d / f"diffuse{ext}"
        for d in INBOX_DIRS
        for ext in (".png", ".jpg", ".jpeg", ".webp")
    ]
    source = next((p for p in candidates if p.exists()), None)
    if not source:
        return jsonify({"error": "No inbox texture. Use Seamless Texture Maker → Open in Texture Map Maker."}), 404

    out_dir = _session_dir()
    dest = out_dir / f"upload{source.suffix.lower() or '.png'}"
    shutil.copy2(source, dest)
    session["diffuse_name"] = dest.name

    # default params if none provided
    try:
        if request.method == "POST" and request.form:
            params = _params_from_request()
            params["tileable"] = True
        else:
            params = {
                "height_strength": 1.0,
                "height_blur": 0.5,
                "height_contrast": 1.0,
                "height_invert": False,
                "height_level": 0.0,
                "normal_strength": 2.0,
                "normal_blur": 0.0,
                "normal_invert_x": False,
                "normal_invert_y": True,
                "roughness_method": "variance",
                "roughness_strength": 1.0,
                "roughness_blur": 1.5,
                "roughness_contrast": 1.0,
                "roughness_invert": False,
                "roughness_base": 0.5,
                "include_ao": True,
                "ao_strength": 1.0,
                "ao_blur": 2.0,
                "max_size": 2048,
                "tileable": True,
            }
        maps = generate_all_maps(dest, out_dir, **params)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    flag = source.parent / "pending.flag"
    if flag.exists():
        try:
            flag.unlink()
        except OSError:
            pass

    sid = session.get("sid")
    previews = {
        k: f"/outputs/{sid}/{v}"
        for k, v in maps.items()
        if k in ("diffuse", "height", "normal", "roughness", "ao") and isinstance(v, str)
    }
    return jsonify(
        {
            "ok": True,
            "maps": maps,
            "previews": previews,
            "uploaded": True,
            "from": "seamless",
            "download_zip": "/api/download-zip",
        }
    )


def main():
    port = int(os.getenv("PORT") or 5100)
    print(
        f"""
╔══════════════════════════════════════════════════╗
║   Texture Map Maker · Normal / Height / Rough    ║
╠══════════════════════════════════════════════════╣
║  Open:  http://127.0.0.1:{port:<5}                     ║
║  Mode:  Free · offline · no API key              ║
╚══════════════════════════════════════════════════╝
"""
    )
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
