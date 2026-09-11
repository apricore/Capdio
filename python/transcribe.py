import sys
import json
import importlib

import whisper


whisper_transcribe = importlib.import_module(
    "whisper.transcribe"
)


class ProgressBar:
    def __init__(self, total, **kwargs):
        self.total = total
        self.current = 0

    def update(self, n):
        self.current += n

        if self.total > 0:
            progress = self.current / self.total

            print(
                f"PROGRESS:{progress:.4f}",
                file=sys.stderr,
                flush=True
            )

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def main():
    audio_file = sys.argv[1]

    print(
        "STATUS:Loading Whisper...",
        file=sys.stderr,
        flush=True
    )

    model = whisper.load_model("base")

    print(
        "STATUS:Transcribing...",
        file=sys.stderr,
        flush=True
    )

    original_tqdm = whisper_transcribe.tqdm.tqdm

    whisper_transcribe.tqdm.tqdm = ProgressBar

    try:
        result = model.transcribe(
            audio_file,
            verbose=False
        )
    finally:
        whisper_transcribe.tqdm.tqdm = original_tqdm

    print(json.dumps({
        "text": result["text"],
        "segments": result["segments"]
    }))


if __name__ == "__main__":
    main()