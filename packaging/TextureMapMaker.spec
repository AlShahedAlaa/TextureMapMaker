# PyInstaller spec — builds the Mac .app and the Windows app folder.
#   pyinstaller packaging/TextureMapMaker.spec --noconfirm
import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, ROOT)
from version import APP_NAME, __version__  # noqa: E402

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")

datas = [
    (os.path.join(ROOT, "templates"), "templates"),
    (os.path.join(ROOT, "static"), "static"),
]

hiddenimports = []
try:
    from PyInstaller.utils.hooks import collect_submodules

    hiddenimports += collect_submodules("webview")
except Exception:
    pass

a = Analysis(
    [os.path.join(ROOT, "desktop.py")],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "scipy", "pandas", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

icon = os.path.join(SPECPATH, "icon.icns" if IS_MAC else "icon.ico")

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TextureMapMaker" if not IS_MAC else APP_NAME,
    console=False,  # no terminal window
    icon=icon,
    upx=False,
    target_arch=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    upx=False,
    name="TextureMapMaker",
)

if IS_MAC:
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=icon,
        bundle_identifier="com.alaaalshahed.texturemapmaker",
        version=__version__,
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "CFBundleShortVersionString": __version__,
            "CFBundleVersion": __version__,
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
            "NSHumanReadableCopyright": "Free · offline · 3D بالعربي",
            "LSApplicationCategoryType": "public.app-category.graphics-design",
        },
    )
