"""Make the web page's demo audio: the mock reply, one sentence at a time, in
a few Kokoro voices, joined with short gaps, plus each sentence's start and
end. Run with the Python that has Kokoro:
  <a Python with Kokoro> -I tools/make_demo.py
"""
import json, os, subprocess, sys, wave

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "plugin", "bin"))
from engines import Engines, RATE  # noqa: E402

SENTENCES = [
    "The build fails because parseVoices moved, but two files still import it from the old place.",
    "I pointed both imports at voices dot T S, so the build passes again.",
    "Then I ran the whole test suite, and all 42 tests pass.",
]
VOICES = ["kokoro:af_heart", "kokoro:bf_emma", "kokoro:am_fenrir"]
GAP = 0.3  # seconds of silence between sentences, as the service leaves
OUT = os.path.join(REPO, "docs", "demo")

engines = Engines()
timings = {}
for voice in VOICES:
    pcm, marks, at = b"", [], 0.0
    for s in SENTENCES:
        audio = engines.synth(voice, s)
        dur = len(audio) / 2 / RATE
        marks.append([round(at, 3), round(at + dur, 3)])
        pcm += audio + b"\0\0" * int(GAP * RATE)
        at += dur + GAP
    name = voice.split(":")[1]
    wav = os.path.join(OUT, name + ".wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-b:a", "64k", os.path.join(OUT, name + ".mp3")], check=True)
    os.remove(wav)
    timings[name] = marks
    print(voice, marks)
with open(os.path.join(OUT, "timings.json"), "w") as f:
    json.dump(timings, f, indent=1)
