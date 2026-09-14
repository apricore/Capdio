import os
from pathlib import Path

import whisper


model_directory = Path(__file__).resolve().parents[1] / "resources" / "models"
model_directory.mkdir(parents=True, exist_ok=True)
whisper.load_model("base", download_root=str(model_directory))
print(f"Whisper base model is ready in {model_directory}")
