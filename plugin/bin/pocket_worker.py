"""read-along's Pocket TTS worker: run by the speech service in the Python that
has Pocket TTS (`pocketPython` in config.json), so the service's own Python
needs neither Pocket TTS nor PyTorch.

One JSON request per line on stdin, one answer per line on stdout:

    {"op": "warm", "voice": "alba", "language": "english"}  ->  OK
    {"text": "Hello.", "voice": "alba", "language": "english"} ->  OK <base64 16-bit PCM>
    anything that fails                                       ->  ERR <message>

The first line out is `READY <sample rate> <cloning>` once the default
language's model has loaded; `<cloning>` is 1 when the model can clone a voice
from a recording (Hugging Face access to kyutai/pocket-tts), else 0, when
only the built-in voices and saved voice states work.

A voice is a built-in name (alba, marius, ...), a `.safetensors` voice state
(from `pocket-tts export-voice`, loads at once) or a recording (cloned on
first use, then kept). Each language has its own model, loaded when first
asked for.

    pocket_worker.py [--threads N] [--language english]
"""

import argparse
import base64
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--language", default="english")
    a = ap.parse_args()

    # Answers go to the real stdout; anything the packages print goes to stderr.
    out = sys.stdout
    sys.stdout = sys.stderr

    import torch

    torch.set_num_threads(max(1, a.threads))
    from pocket_tts import TTSModel

    models: dict = {}
    states: dict = {}

    def model(language):
        if language not in models:
            models[language] = TTSModel.load_model(language=language)
        return models[language]

    def state(language, voice):
        if (language, voice) not in states:
            states[(language, voice)] = model(language).get_state_for_audio_prompt(voice)
        return states[(language, voice)]

    def answer(line):
        out.write(line + "\n")
        out.flush()

    first = model(a.language)
    answer(f"READY {first.sample_rate} {int(bool(getattr(first, 'has_voice_cloning', True)))}")
    for line in sys.stdin:
        try:
            req = json.loads(line)
            language = req.get("language") or a.language
            voice = state(language, req["voice"])
            if req.get("op") == "warm":
                answer("OK")
                continue
            with torch.no_grad():
                audio = model(language).generate_audio(voice, str(req["text"]))
            pcm = (audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().astype("<i2").tobytes()
            answer("OK " + base64.b64encode(pcm).decode())
        except Exception as err:  # noqa: BLE001 - every failure is reported, the worker stays up
            answer("ERR " + " ".join(f"{type(err).__name__}: {err}".split()))


if __name__ == "__main__":
    main()
