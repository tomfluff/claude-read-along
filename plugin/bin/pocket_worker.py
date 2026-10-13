"""read-along's Pocket TTS worker: run by the speech service in the Python that
has Pocket TTS (`pocketPython` in config.json), so the service's own Python
needs neither Pocket TTS nor PyTorch.

One JSON request per line on stdin, one answer per line on stdout:

    {"op": "warm", "voice": "alba", "language": "english"}  ->  OK
    {"text": "Hello.", "voice": "alba", "language": "english"} ->  OK <base64 16-bit PCM>
    the same with "stream": true   ->  PART <base64 16-bit PCM>, one per piece, then OK
    anything that fails                                       ->  ERR <message>

A stream sends each piece (about 80 ms) as Pocket TTS's own
`generate_audio_stream` decodes it, so playback can start long before the
sentence is finished; `generate_audio` collects that same stream.

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

    def pcm(audio):
        """A tensor of samples as base64 16-bit PCM."""
        return base64.b64encode((audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().astype("<i2").tobytes()).decode()

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
                if req.get("stream"):
                    for piece in model(language).generate_audio_stream(voice, str(req["text"])):
                        answer("PART " + pcm(piece))
                    answer("OK")
                else:
                    answer("OK " + pcm(model(language).generate_audio(voice, str(req["text"]))))
        except Exception as err:  # noqa: BLE001 - every failure is reported, the worker stays up
            answer("ERR " + " ".join(f"{type(err).__name__}: {err}".split()))


if __name__ == "__main__":
    main()
