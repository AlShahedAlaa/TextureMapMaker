# Texture Map Maker (Free · Offline)

Upload a **diffuse** texture and generate:

- **Normal map**
- **Height / displacement map**
- **Roughness map**
- **AO map** (optional)
- **Seamless / tileable textures** — built in, no extra app needed

Adjust strength, blur, contrast, invert, and more. Download all as a **ZIP**.

**No API key. 100% free. Runs on your Mac.**

## Install (no Python needed)

Download from the **Releases** page:

| System | File | How |
|--------|------|-----|
| **Mac (M1–M4)** | `TextureMapMaker-x.y.z-macOS-AppleSilicon.dmg` | Open → drag the app to **Applications** |
| **Mac (Intel)** | `TextureMapMaker-x.y.z-macOS-Intel.dmg` | Same |
| **Windows** | `TextureMapMaker-x.y.z-Windows-Setup.exe` | Run → Next → Finish (no admin needed) |
| **Windows (no install)** | `TextureMapMaker-x.y.z-Windows-Portable.zip` | Unzip → run `TextureMapMaker.exe` |

The app opens in its own window and works fully offline.

**First launch warnings** (the app isn't code-signed yet):
- **Mac:** "Apple could not verify…" → **System Settings → Privacy & Security** → scroll down → **Open Anyway**. Once only.
- **Windows:** "Windows protected your PC" → **More info → Run anyway**. Once only.

Your files are kept in `~/Library/Application Support/TextureMapMaker` (Mac) or `%APPDATA%\TextureMapMaker` (Windows). Old sessions are cleared after 7 days.

## Run from source (developers)

```bash
cd ~/Desktop/TextureMapMaker
python3 -m pip install -r requirements.txt
python3 app.py            # browser version → http://127.0.0.1:5100
# or, desktop window:
python3 -m pip install pywebview && python3 desktop.py
```

## Building the apps

Mac apps must be built on a Mac and Windows apps on Windows, so GitHub builds both automatically (`.github/workflows/build.yml`):

1. Push this folder to a GitHub repository.
2. Every push to `main` builds the apps and publishes them to the **Releases** page as `v<version>` (from `version.py`).
3. New version: change `version.py` (e.g. `1.2.0`) and push — a new release appears with the `.dmg`, `Setup.exe` and portable `.zip`.

Each build runs a self-test of the packaged app (UI, 3D library, seamless maps) before publishing.

**Removing the first-launch warnings (optional):**
- Mac: an Apple Developer account ($99/yr). Add these repository secrets and builds get signed + notarized automatically: `APPLE_CERT_P12` (base64 of your Developer ID .p12), `APPLE_CERT_PASSWORD`, `APPLE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.
- Windows: a code-signing certificate (or Azure Trusted Signing). Without one, SmartScreen warns until the app has enough downloads.

## Seamless textures

Turn on **Seamless** in the sidebar, then check the result with the **2×2 / 3×3** buttons under the preview (or the **Tiling** slider in 3D view).

| Method | Best for |
|--------|----------|
| **Smart cut** | Stone, brick, wood, fabric — finds the least visible cut path, keeps detail sharp |
| **Soft blend** | Grass, sand, concrete, noise — smooth cross-fade without going flat |
| **Mirror** | Abstract patterns — always seamless, but shows symmetry |

- **Edge zone** — how much of the edge is reworked (bigger = smoother seam, more change)
- **Even light** — removes lighting gradients/hotspots that make repeats obvious
- When seamless is on, the normal / height / roughness / AO maps are generated wrap-aware, so they tile too
- Your original upload is never changed — toggle seamless off to get it back

## Tips

| Engine | Normal Y |
|--------|----------|
| Blender / OpenGL / Unreal (often) | Invert Y **ON** |
| DirectX / some Unity setups | Invert Y **OFF** |

- White roughness = rough; black = smooth  
- Start with Normal strength ~1.5–3  
- Use Height for displacement / parallax  

## Stack

Python · Flask · Pillow · NumPy (local image processing only) · three.js (bundled) · pywebview (desktop window) · PyInstaller + Inno Setup (packaging)
