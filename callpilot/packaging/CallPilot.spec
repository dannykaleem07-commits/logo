# PyInstaller spec - build with:  pyinstaller packaging/CallPilot.spec --noconfirm
# Produces dist/CallPilot.exe (single file, no console window).
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

ROOT = Path(SPECPATH).parent

hidden = (
    collect_submodules("pynput")
    + collect_submodules("keyring.backends")
    + ["websockets.sync.client", "win32ctypes.core", "win32ctypes.pywin32", "win32com.client", "pythoncom", "pywintypes", "pyaudiowpatch", "pycaw.pycaw", "comtypes.stream", "docx", "pypdf"]
)

a = Analysis(
    [str(ROOT / "callpilot" / "app.py")],
    pathex=[str(ROOT)],
    datas=[
        (str(ROOT / "callpilot" / "hubs" / "builtin"), "callpilot/hubs/builtin"),
        (str(ROOT / "assets" / "icon.png"), "assets"),
    ] + copy_metadata("keyring"),  # keyring discovers WinVaultKeyring through entry-point metadata
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PySide6.QtWebEngineCore",
              "PySide6.QtWebEngineWidgets", "PySide6.Qt3DCore", "PySide6.QtQuick", "PySide6.QtQml",
              "PySide6.QtMultimedia", "PySide6.QtCharts", "PySide6.QtDataVisualization"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="CallPilot",
    icon=str(ROOT / "assets" / "icon.ico"),
    version=str(ROOT / "packaging" / "version_info.txt"),
    console=False,
    upx=False,
    runtime_tmpdir=None,
)
