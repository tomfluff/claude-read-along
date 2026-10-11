"""Makes one sentence with the `auto` voice of this machine and checks it is
speech-length audio. CI runs it on Linux (eSpeak NG) and macOS (`say`).

    python3 -I plugin/tests/smoke.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))

from engines import PLATFORM, RATE, Engines  # noqa: E402

engines = Engines()
voice = engines.auto("main")
print(f"platform {PLATFORM}, auto voice {voice}, {len(engines.voices())} voices installed")
if not voice:
    sys.exit("no voice found")
pcm = engines.synth(voice, "Read-along is working on this machine.")
seconds = len(pcm) / 2 / RATE
print(f"made {seconds:.1f}s of speech")
if not 1.0 < seconds < 10.0:
    sys.exit("speech length looks wrong")
