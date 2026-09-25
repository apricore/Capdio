import os
import sys

from cx_Freeze import Executable, setup


sys.setrecursionlimit(10000)


setup(
    name="capdio-transcribe",
    version="1.0.0",
    options={
        "build_exe": {
            "packages": ["torch", "whisper", "tiktoken", "numba", "llvmlite"],
            "includes": [
                "whisper.transcribe",
                "numba.core.types.old_scalars",
                "numba.core.types.new_scalars",
                "unittest",
                "unittest.case",
                "unittest.loader",
                "unittest.suite",
            ],
            "excludes": ["PyQt5", "PyQt6", "PySide2", "PySide6"],
        }
    },
    executables=[
        Executable(
            os.path.join(os.path.dirname(__file__), "transcribe.py"),
            target_name="capdio-transcribe.exe" if sys.platform == "win32" else "capdio-transcribe",
        )
    ],
)