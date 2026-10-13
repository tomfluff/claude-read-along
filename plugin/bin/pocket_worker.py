"""read-along's Pocket TTS worker: run by the speech service in the Python that
has Pocket TTS (`pocketPython` in config.json), so the service's own Python
needs neither Pocket TTS nor PyTorch.

One JSON request per line on stdin, one answer per line on stdout:

    {"op": "warm", "voice": "/path/me.safetensors"}   ->  OK
    {"text": "Hello.", "voice": "/path/me.safetensors"} ->  OK <base64 16-bit PCM>
    anything that fails                                 ->  ERR <message>

The first line out is `READY <sample rate>`, once the model has loaded. A voice
is a file: a `.safetensors` voice state (from Pocket TTS's `export-voice`,
loads at once) or a recording (cloned on first use, then kept).

    pocket_worker.py [--threads N] [--language english]
"""

import argparse
import base64
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--language", default=None)
    a = ap.parse_args()

    # Answers go to the real stdout; anything the packages print goes to stderr.
    out = sys.stdout
    sys.stdout = sys.stderr

    import torch

    torch.set_num_threads(max(1, a.threads))
    from pocket_tts import TTSModel

    model = TTSModel.load_model(language=a.language) if a.language else TTSModel.load_model()
    states: dict = {}

    def state(path):
        if path not in states:
            states[path] = model.get_state_for_audio_prompt(path)
        return states[path]

    def answer(line):
        out.write(line + "\n")
        out.flush()

    answer(f"READY {model.sample_rate}")
    for line in sys.stdin:
        try:
            req = json.loads(line)
            voice = state(req["voice"])
            if req.get("op") == "warm":
                answer("OK")
                continue
            with torch.no_grad():
                audio = model.generate_audio(voice, str(req["text"]))
            pcm = (audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().astype("<i2").tobytes()
            answer("OK " + base64.b64encode(pcm).decode())
        except Exception as err:  # noqa: BLE001 - every failure is reported, the worker stays up
            answer("ERR " + " ".join(f"{type(err).__name__}: {err}".split()))


if __name__ == "__main__":
    main()
