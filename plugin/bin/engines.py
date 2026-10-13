"""Speech engines and the platform for read-along's speech service.

Every engine turns one sentence into 16-bit mono PCM at RATE Hz. A voice is
named `<engine>:<voice>`:

    kokoro:af_heart              Kokoro, the neural voices bin/setup.py installs
    win:Microsoft Aria           the Windows (SAPI) voices, from WSL
    mac:Samantha                 the macOS voices (`say`)
    espeak:en-us                 eSpeak NG, robotic but everywhere on Linux
    pocket:alba, pocket:me       Pocket TTS: its own voices, and yours (me.wav)

and `auto` picks the best voice installed for the text's language. Names from
before engines were named still work: a bare Kokoro name (af_heart) is Kokoro,
a bare name with a space in it (Microsoft Aria Native) is Windows.

Only the standard library is needed here. Kokoro brings its own packages,
which bin/setup.py installs into the data folder's own Python.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from array import array

RATE = 24000


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- platform

def platform_name() -> str:
    """wsl, linux, macos or windows."""
    if sys.platform == "darwin":
        return "macos"
    if sys.platform == "win32":
        return "windows"
    if os.environ.get("WSL_DISTRO_NAME"):
        return "wsl"
    try:
        with open("/proc/sys/kernel/osrelease") as f:
            if "microsoft" in f.read().lower():
                return "wsl"
    except OSError:
        pass
    return "linux"


PLATFORM = platform_name()


def data_dir() -> str:
    """Where setup puts Kokoro's Python, its model and config.json.

    Kept short on purpose: eSpeak NG ignores a data path over 160 characters,
    and Kokoro's packages load eSpeak's data from inside this folder.
    """
    if os.environ.get("READ_ALONG_DATA"):
        return os.environ["READ_ALONG_DATA"]
    if PLATFORM == "macos":
        return os.path.expanduser("~/Library/Application Support/claude-read-along")
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "claude-read-along")


def read_config() -> dict:
    try:
        with open(os.path.join(data_dir(), "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main_language() -> str:
    """The language of text in Latin script, from config.json or $LANG (en by default)."""
    lang = read_config().get("mainLanguage")
    if lang:
        return str(lang).lower()
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        v = os.environ.get(var, "")
        m = re.match(r"([a-z]{2,3})(?:[_-]|$)", v)
        if m and m.group(1) not in ("c", "posix"):
            return m.group(1)
    return "en"


# ---------------------------------------------------------------- languages
#
# Text is routed by script: Latin text goes to the main voice, and each other
# script to its own group's voice. A group is named by its language.

GROUP_LANGS = {
    "ja": ["ja"], "zh": ["zh", "cmn", "yue"], "ko": ["ko"], "he": ["he", "iw"],
    "ar": ["ar", "fa", "ur"], "ru": ["ru", "uk", "bg", "sr", "be"], "hi": ["hi", "mr", "ne"],
    "el": ["el"], "th": ["th"],
}

RANGES = {
    "kana": [(0x3040, 0x30FF), (0x31F0, 0x31FF)],
    "han": [(0x4E00, 0x9FFF), (0x3400, 0x4DBF)],
    "ko": [(0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)],
    "he": [(0x0590, 0x05FF)],
    "ar": [(0x0600, 0x06FF), (0x0750, 0x077F)],
    "ru": [(0x0400, 0x04FF)],
    "hi": [(0x0900, 0x097F)],
    "el": [(0x0370, 0x03FF)],
    "th": [(0x0E00, 0x0E7F)],
}


def _in(ch, ranges):
    o = ord(ch)
    return any(a <= o <= b for a, b in ranges)


def script_of(text: str, chosen: dict | None = None) -> str:
    """The voice group a sentence goes to: `main`, or a group such as `ja`.

    Chinese characters with no kana are Chinese, unless only a Japanese voice
    was chosen (a short Japanese sentence can be all kanji).
    """
    letters = sum(1 for ch in text if ch.isalpha()) or 1
    counts = {k: sum(1 for ch in text if _in(ch, r)) for k, r in RANGES.items()}
    if counts["kana"] and (counts["kana"] + counts["han"]) / letters > 0.2:
        return "ja"
    if counts["han"] / letters > 0.2:
        chosen = chosen or {}
        return "ja" if chosen.get("ja", "auto") != "auto" and chosen.get("zh", "auto") == "auto" else "zh"
    best = max((k for k in counts if k not in ("kana", "han")), key=lambda k: counts[k])
    return best if counts[best] / letters > 0.3 else "main"


def group_langs(group: str) -> list[str]:
    return [main_language()] if group == "main" else GROUP_LANGS.get(group, [group])


# ---------------------------------------------------------------- audio helpers

def resample(pcm: bytes, src: int, dst: int = RATE) -> bytes:
    """16-bit mono PCM from `src` Hz to `dst` Hz, by linear interpolation:
    plenty for speech, and no packages needed."""
    if src == dst or not pcm:
        return pcm
    a = array("h")
    a.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        a.byteswap()
    n = int(len(a) * dst / src)
    step = src / dst
    out = array("h", bytes(2 * n))
    last = len(a) - 1
    for i in range(n):
        x = i * step
        j = int(x)
        f = x - j
        y0 = a[j]
        y1 = a[j + 1] if j < last else y0
        out[i] = int(y0 + (y1 - y0) * f)
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def wav_to_pcm(data: bytes) -> bytes:
    """A WAV file's samples as 16-bit mono PCM at RATE."""
    with wave.open(io.BytesIO(data)) as w:
        channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise RuntimeError(f"unsupported WAV sample width {width}")
    if channels > 1:  # keep the first channel
        a = array("h")
        a.frombytes(frames)
        frames = array("h", a[::channels]).tobytes()
    return resample(frames, rate)


def float_to_pcm(samples) -> bytes:
    """Float samples (a NumPy array or a list, -1 to 1) as 16-bit PCM."""
    try:
        import numpy as np

        return (np.clip(np.asarray(samples, dtype="float32"), -1, 1) * 32767).astype("<i2").tobytes()
    except ImportError:
        return array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in samples)).tobytes()


# ---------------------------------------------------------------- engines

class Engine:
    name = ""
    label = ""

    def available(self) -> tuple[bool, str]:
        """(usable, why not)."""
        return False, "not implemented"

    def voices(self) -> list[dict]:
        """[{id, name, lang}], lang a BCP 47 tag such as en-US."""
        return []

    def best(self, langs: list[str]) -> str | None:
        """The voice `auto` takes for these languages, without the engine prefix."""
        return None

    def synth(self, text: str, voice: str) -> bytes:
        raise NotImplementedError

    def warm(self, voice: str):
        pass

    def close(self):
        pass


def _lang_of(tag: str) -> str:
    return re.split(r"[-_]", tag.lower())[0]


# -- Kokoro

KOKORO_LANGS = {"a": "en-US", "b": "en-GB", "j": "ja", "z": "zh", "e": "es", "f": "fr", "h": "hi", "i": "it", "p": "pt-BR"}
KOKORO_VOICES = (
    "af_heart af_bella af_nicole af_aoede af_kore af_sarah af_nova af_sky af_alloy af_jessica af_river "
    "am_fenrir am_michael am_puck am_echo am_eric am_liam am_onyx am_adam am_santa "
    "bf_emma bf_isabella bf_alice bf_lily bm_george bm_fable bm_lewis bm_daniel "
    "jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo "
    "zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang "
    "ef_dora em_alex em_santa ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola pf_dora pm_alex pm_santa"
).split()
KOKORO_BEST = {"en": "af_heart", "ja": "jf_alpha", "zh": "zf_xiaobei", "es": "ef_dora", "fr": "ff_siwis",
               "hi": "hf_alpha", "it": "if_sara", "pt": "pf_dora"}
# kokoro-onnx's own eSpeak phonemizer, for languages misaki has no rules for here.
ESPEAK_CODES = {"e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br", "z": "cmn"}


def _japanese_dictionary():
    """misaki's Japanese rules look for the `unidic` dictionary, which needs a
    500 MB download; the bundled unidic-lite one does the job."""
    try:
        import unidic_lite
    except ImportError:
        return
    sys.modules.setdefault("unidic", unidic_lite)
    if not hasattr(sys.modules["unidic"], "DICDIR"):
        sys.modules["unidic"] = unidic_lite


class Kokoro(Engine):
    """Kokoro-82M, through whichever is installed in this Python:
    `kokoro` (PyTorch, GPU when there is one) or `kokoro-onnx` (CPU, smaller;
    bin/setup.py installs this one), with misaki's pronunciation rules.
    Both read `[word](/IPA/)` as an exact pronunciation."""

    name = "kokoro"
    label = "Kokoro"

    def __init__(self):
        self.lock = threading.Lock()
        self.load_lock = threading.Lock()
        self.pipes: dict = {}  # PyTorch: one KPipeline per language letter
        self.g2p: dict = {}  # onnx: one misaki G2P per language letter
        self.onnx = None
        self.device = None

    def backend(self) -> str | None:
        if importlib.util.find_spec("kokoro"):
            return "torch"
        if importlib.util.find_spec("kokoro_onnx") and self._model_files():
            return "onnx"
        return None

    def _model_files(self):
        models = os.path.join(data_dir(), "models")
        files = (os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
        return files if all(os.path.exists(f) for f in files) else None

    def available(self):
        if self.backend():
            return True, ""
        if importlib.util.find_spec("kokoro_onnx"):
            return False, "its model isn't downloaded; run setup again"
        return False, "not installed"

    def langs(self) -> set[str]:
        """Language letters this install can speak: English always, the others
        when their pronunciation packages are there."""
        out = {"a", "b"}
        if importlib.util.find_spec("fugashi") and (importlib.util.find_spec("unidic_lite") or importlib.util.find_spec("unidic")):
            out.add("j")
        if importlib.util.find_spec("espeakng_loader"):
            out |= {"e", "f", "h", "i", "p", "z"}
        return out

    def voices(self):
        if not self.backend():
            return []
        langs = self.langs()
        return [{"id": f"kokoro:{v}", "name": v.split("_", 1)[1], "lang": KOKORO_LANGS[v[0]]}
                for v in KOKORO_VOICES if v[0] in langs]

    def best(self, langs):
        if not self.backend():
            return None
        for lang in langs:
            v = KOKORO_BEST.get(lang)
            if v and v[0] in self.langs():
                return v
        return None

    def _letter(self, voice):
        return voice[0] if voice[:1] in KOKORO_LANGS else "a"

    def warm(self, voice):
        with self.load_lock:
            if self.backend() == "torch":
                self._pipe(self._letter(voice))
            else:
                self._onnx()
                self._g2p(self._letter(voice))

    # PyTorch
    def _pipe(self, lang):
        if lang not in self.pipes:
            if lang == "j":
                _japanese_dictionary()
            import torch
            from kokoro import KPipeline

            device = "cuda" if torch.cuda.is_available() else "cpu"
            self.device = device
            t = time.time()
            # One model for every language: only the pronunciation rules differ.
            model = next(iter(self.pipes.values())).model if self.pipes else True
            self.pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=model, device=device)
            log(f"kokoro (torch) '{lang}' on {device} in {time.time() - t:.1f}s")
        return self.pipes[lang]

    # onnx
    def _onnx(self):
        if self.onnx is None:
            from kokoro_onnx import Kokoro as KokoroOnnx

            t = time.time()
            self.onnx = KokoroOnnx(*self._model_files())
            self.device = "cpu"
            log(f"kokoro (onnx) loaded in {time.time() - t:.1f}s")
        return self.onnx

    def _g2p(self, lang):
        """misaki's rules for English and Japanese; None where kokoro-onnx's
        own eSpeak phonemizer is used instead."""
        if lang not in self.g2p:
            g2p = None
            if lang in "ab":
                from misaki import en, espeak

                fallback = espeak.EspeakFallback(british=lang == "b")
                g2p = en.G2P(trf=False, british=lang == "b", fallback=fallback)
            elif lang == "j":
                _japanese_dictionary()
                from misaki import ja

                g2p = ja.JAG2P()
            self.g2p[lang] = g2p
        return self.g2p[lang]

    def synth(self, text, voice):
        lang = self._letter(voice)
        with self.lock:
            if self.backend() == "torch":
                pipe = self._pipe(lang)
                chunks = [r.audio.numpy() for r in pipe(text, voice=voice, speed=1.0) if r.audio is not None]
                if not chunks:
                    return b""
                import numpy as np

                return float_to_pcm(np.concatenate(chunks))
            model = self._onnx()
            g2p = self._g2p(lang)
            if g2p is not None:
                phonemes = g2p(text)[0]
                if not phonemes.strip():
                    return b""
                samples, rate = model.create(phonemes, voice=voice, speed=1.0, is_phonemes=True)
            else:
                samples, rate = model.create(text, voice=voice, speed=1.0, lang=ESPEAK_CODES.get(lang, "en-us"))
        return resample(float_to_pcm(samples), rate)


# -- Windows (from WSL)

WIN_WORKER = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$tmp = [IO.Path]::GetTempPath()
[Console]::Out.WriteLine('READY ' + $tmp); [Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $req = $line | ConvertFrom-Json
    if ($req.op -eq 'voices') {
      $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }
      [Console]::Out.WriteLine('VOICES ' + ($v -join ';')); [Console]::Out.Flush(); continue
    }
    if ($req.voice) { $s.SelectVoice($req.voice) }
    $out = Join-Path $tmp $req.file
    $fs = [IO.File]::Create($out)
    try {
      $s.SetOutputToAudioStream($fs, $fmt)
      $s.Speak([string]$req.text)
      $s.SetOutputToNull()
    } finally { $fs.Close() }
    [Console]::Out.WriteLine('OK ' + $out)
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}
"""


def powershell() -> str | None:
    for p in ("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", shutil.which("powershell.exe")):
        if p and os.path.exists(p):
            return p
    return None


def run_powershell(script: str) -> subprocess.Popen:
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    return subprocess.Popen(
        [powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", bufsize=1,
    )


class Windows(Engine):
    """The Windows voices, from WSL: a long-lived PowerShell worker around
    System.Speech (SAPI) writing raw 24 kHz PCM to the Windows temp folder.
    Voices added through Windows' own settings show up here when they are SAPI
    voices; the newer "natural" voices need an adapter such as
    NaturalVoiceSAPIAdapter."""

    name = "win"
    label = "Windows"

    def __init__(self):
        self.proc = None
        self.tmp = None
        self.lock = threading.Lock()
        self.n = 0
        self._voices = None

    def available(self):
        if PLATFORM != "wsl":
            return False, "only from WSL"
        if not powershell():
            return False, "powershell.exe not found"
        return True, ""

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        self.proc = run_powershell(WIN_WORKER)
        first = self.proc.stdout.readline().strip()
        if not first.startswith("READY "):
            raise RuntimeError(f"Windows speech worker didn't start: {first!r}")
        self.tmp = first[6:]

    def _ask(self, req):
        self._start()
        self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        return self.proc.stdout.readline().strip()

    def voices(self):
        if not self.available()[0]:
            return []
        if self._voices is None:
            with self.lock:
                line = self._ask({"op": "voices"})
            found = [v.split("|") for v in line[7:].split(";") if v] if line.startswith("VOICES ") else []
            self._voices = [{"id": f"win:{name}", "name": win_short(name), "lang": culture} for name, culture in found]
        return self._voices

    def best(self, langs):
        for lang in langs:
            matches = [v for v in self.voices() if _lang_of(v["lang"]) == lang]
            # Prefer the neural voices (Natural/Native/Neural/Online in their names), then en-US for English.
            matches.sort(key=lambda v: (not re.search(r"Natural|Native|Neural|Online", v["id"]), v["lang"] != "en-US"))
            if matches:
                return matches[0]["id"][4:]
        return None

    def synth(self, text, voice):
        with self.lock:
            self.n += 1
            name = f"read-along-{os.getpid()}-{self.n % 8}.pcm"
            line = self._ask({"text": text, "voice": voice or "", "file": name})
        if not line.startswith("OK "):
            raise RuntimeError(line[4:] or "Windows speech failed")
        path = subprocess.run(["wslpath", "-u", line[3:]], capture_output=True, text=True).stdout.strip()
        with open(path, "rb") as f:
            data = f.read()
        try:
            os.unlink(path)
        except OSError:
            pass
        return data

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


def win_short(name: str) -> str:
    """Microsoft Aria Native → Aria."""
    return re.sub(r" (Native|Desktop|Online|\(Natural\))$", "", re.sub(r"^Microsoft ", "", name)).strip()


# -- macOS

# The usual default voice of each language, to prefer over the rest.
MAC_GOOD = {"Samantha", "Alex", "Ava", "Allison", "Susan", "Tom", "Daniel", "Karen", "Moira", "Kyoko", "Otoya",
            "Carmit", "Tingting", "Meijia", "Sinji", "Yuna", "Monica", "Paulina", "Thomas", "Amelie", "Anna",
            "Alice", "Luciana", "Joana", "Milena", "Maged", "Lekha", "Melina", "Kanya", "Xander", "Zosia"}
# Novelty voices (Albert, Bubbles, Zarvox, …) and the Eloquence ones (Eddy,
# Flo, …): installed everywhere, last choices for reading.
MAC_NOVELTY = {"Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Fred", "Good News", "Jester",
               "Junior", "Kathy", "Organ", "Ralph", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox"}
MAC_ELOQUENCE = {"Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley"}

SAY_LINE = re.compile(r"^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#")


def parse_say_voices(out: str) -> list[dict]:
    """`say -v '?'` lines: `Samantha            en_US    # Hello! My name is Samantha.`"""
    voices = []
    for line in out.splitlines():
        m = SAY_LINE.match(line.rstrip())
        if m:
            name = m.group(1).strip()
            voices.append({"id": f"mac:{name}", "name": name, "lang": m.group(2).replace("_", "-")})
    return voices


class Mac(Engine):
    """The macOS voices through `say`. Better ones (marked Enhanced or
    Premium) are a free download in System Settings → Accessibility → Spoken
    Content → System Voice → Manage Voices."""

    name = "mac"
    label = "macOS"

    def __init__(self):
        self._voices = None

    def available(self):
        if PLATFORM != "macos":
            return False, "only on macOS"
        return (True, "") if shutil.which("say") else (False, "`say` not found")

    def voices(self):
        if not self.available()[0]:
            return []
        if self._voices is None:
            out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
            self._voices = parse_say_voices(out)
        return self._voices

    def best(self, langs):
        def rank(v):
            n = v["name"]
            base = n.split(" (")[0]
            return (
                0 if "Premium" in n else 1 if "Enhanced" in n else 2,
                base not in MAC_GOOD,
                base in MAC_NOVELTY or base in MAC_ELOQUENCE,
                v["lang"] != "en-US",
            )

        for lang in langs:
            matches = sorted((v for v in self.voices() if _lang_of(v["lang"]) == lang), key=rank)
            if matches:
                return matches[0]["name"]
        return None

    def synth(self, text, voice):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.wav")
            cmd = ["say", "-o", path, "--file-format=WAVE", f"--data-format=LEI16@{RATE}", "-f", "-"]
            if voice:
                cmd[1:1] = ["-v", voice]
            run = subprocess.run(cmd, input=text, text=True, capture_output=True)
            if run.returncode != 0:
                raise RuntimeError(run.stderr.strip() or "say failed")
            with open(path, "rb") as f:
                return wav_to_pcm(f.read())


# -- eSpeak NG

def parse_espeak_voices(out: str) -> list[dict]:
    """`espeak-ng --voices` rows: `Pty Language Age/Gender VoiceName File Other Languages`."""
    voices, seen = [], set()
    for line in out.splitlines()[1:]:
        cols = line.split()
        if len(cols) >= 4 and cols[1] not in seen:
            seen.add(cols[1])
            voices.append({"id": f"espeak:{cols[1]}", "name": cols[3].replace("_", " "), "lang": cols[1]})
    return voices


class Espeak(Engine):
    """eSpeak NG: robotic, but it speaks about a hundred languages and is one
    package away on any Linux (`espeak-ng`). The fallback when nothing better
    is installed."""

    name = "espeak"
    label = "eSpeak NG"

    def __init__(self):
        self.exe = shutil.which("espeak-ng") or shutil.which("espeak")
        self._voices = None

    def available(self):
        return (True, "") if self.exe else (False, "not installed")

    def voices(self):
        if not self.exe:
            return []
        if self._voices is None:
            out = subprocess.run([self.exe, "--voices"], capture_output=True, text=True).stdout
            self._voices = parse_espeak_voices(out)
        return self._voices

    def best(self, langs):
        for lang in langs:
            ids = [v["lang"] for v in self.voices()]
            for want in ([f"{lang}-us", lang] if lang == "en" else [lang]):
                if want in ids:
                    return want
            matches = [i for i in ids if _lang_of(i) == lang]
            if matches:
                return matches[0]
        return None

    def synth(self, text, voice):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.wav")
            run = subprocess.run([self.exe, "-v", voice or "en", "-w", path, "--", text], capture_output=True, text=True)
            if run.returncode != 0:
                raise RuntimeError(run.stderr.strip() or "espeak failed")
            with open(path, "rb") as f:
                return wav_to_pcm(f.read())


# -- Pocket TTS (more voices, and a voice of your own)

# Pocket TTS's languages, each a model of its own, by language code.
POCKET_LANGS = {"en": "english", "fr": "french", "de": "german", "it": "italian", "pt": "portuguese",
                "es": "spanish", "nl": "dutch"}
# The voices every Pocket TTS language model has built in (kyutai/tts-voices).
POCKET_BUILTIN = (
    "alba anna azelma bill_boerst caro_davy charles cosette daan eponine estelle eve fantine george giovanni "
    "jane javert jean juergen lola marius mary michael paul peter_yearsley rafael stuart_bell vera"
).split()
POCKET_FILES = (".safetensors", ".wav", ".mp3", ".flac", ".ogg")


class Pocket(Engine):
    """Kyutai's Pocket TTS: 27 built-in voices, and voices of your own, each a
    file in the `pocketVoices` folder, a `.safetensors` voice state (made by
    `pocket-tts export-voice`, loads at once) or a recording (cloned on first
    use; needs Hugging Face access to kyutai/pocket-tts). Pocket TTS and
    PyTorch stay in their own Python (`pocketPython`; bin/setup.py pocket
    installs one in the data folder), run as a worker (bin/pocket_worker.py).
    It reads the main language when Pocket TTS has it (English, French,
    German, Italian, Portuguese, Spanish, Dutch), else English. About 3x
    faster than real time on 4 CPU threads; `auto` never picks it."""

    name = "pocket"
    label = "Pocket TTS"

    def __init__(self):
        self.proc = None
        self.rate = RATE
        self.cloning = None
        self.lock = threading.Lock()

    @staticmethod
    def python() -> str | None:
        cfg = read_config()
        if cfg.get("pocket") is False:  # turned off with `setup.py pocket-off`
            return None
        if cfg.get("pocketPython"):
            return cfg["pocketPython"]
        venv = os.path.join(data_dir(), "pocket", "bin", "python")
        return venv if os.path.exists(venv) else None

    @staticmethod
    def folder() -> str:
        return read_config().get("pocketVoices") or os.path.join(data_dir(), "voices")

    @staticmethod
    def language() -> tuple[str, str]:
        """(code, Pocket TTS's name for it): the main language's, else English."""
        code = main_language()
        return (code, POCKET_LANGS[code]) if code in POCKET_LANGS else ("en", "english")

    def available(self):
        python = self.python()
        if not python:
            return False, "not installed (optional: 27 more voices and a voice of your own)"
        if not os.path.exists(python):
            return False, f"its Python is gone: {python}"
        return True, ""

    def own(self) -> dict[str, str]:
        """Your voices: name -> file; a `.safetensors` wins over a recording of the same name."""
        try:
            names = sorted(os.listdir(self.folder()))
        except OSError:
            return {}
        found: dict[str, str] = {}
        for f in names:
            stem, ext = os.path.splitext(f)
            if ext.lower() in POCKET_FILES and (stem not in found or ext.lower() == ".safetensors"):
                found[stem] = os.path.join(self.folder(), f)
        return found

    def voices(self):
        if not self.available()[0]:
            return []
        code, _ = self.language()
        own = self.own()
        return ([{"id": f"pocket:{n}", "name": n, "lang": code, "own": True} for n in own]
                + [{"id": f"pocket:{n}", "name": n, "lang": code} for n in POCKET_BUILTIN if n not in own])

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        threads = int(read_config().get("pocketThreads") or min(4, os.cpu_count() or 4))
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pocket_worker.py")
        t = time.time()
        self.proc = subprocess.Popen(
            [self.python(), "-I", worker, "--threads", str(threads), "--language", self.language()[1]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
        )
        first = self.proc.stdout.readline().split()
        if first[:1] != ["READY"]:
            self.proc.kill()
            raise RuntimeError("Pocket TTS didn't start; see the service log")
        self.rate = int(first[1])
        self.cloning = first[2:3] != ["0"]
        log(f"pocket tts loaded in {time.time() - t:.1f}s ({threads} threads, "
            f"{'clones recordings' if self.cloning else 'built-in voices and voice states only'})")

    def _ask(self, req: dict) -> str:
        name = req["voice"]
        voice = self.own().get(name) or (name if name in POCKET_BUILTIN else None)
        if not voice:
            raise RuntimeError(f"no Pocket TTS voice named {name}")
        with self.lock:
            self._start()
            self.proc.stdin.write(json.dumps(dict(req, voice=voice, language=self.language()[1]), ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline().strip()
        if not line.startswith("OK"):
            raise RuntimeError(line[4:] or "Pocket TTS stopped; see the service log")
        return line[3:]

    def warm(self, voice):
        self._ask({"op": "warm", "voice": voice})

    def synth(self, text, voice):
        return resample(base64.b64decode(self._ask({"text": text, "voice": voice})), self.rate)

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


# ---------------------------------------------------------------- choosing a voice

# The order `auto` tries engines in: the neural voices first, eSpeak last.
# Pocket TTS never answers `auto`; it is listed so its voices can be chosen.
ORDER = ["kokoro", "mac", "win", "espeak", "pocket"]


class Engines:
    def __init__(self):
        self.by_name: dict[str, Engine] = {e.name: e for e in (Kokoro(), Windows(), Mac(), Espeak(), Pocket())}
        self._auto: dict[str, str | None] = {}

    def usable(self) -> list[Engine]:
        return [self.by_name[n] for n in ORDER if self.by_name[n].available()[0]]

    def voices(self) -> list[dict]:
        out = []
        for e in self.usable():
            try:
                out += [dict(v, engine=e.name) for v in e.voices()]
            except Exception as err:
                log(f"listing {e.name} voices failed:", err)
        return out

    @staticmethod
    def split(voice: str) -> tuple[str, str]:
        """`kokoro:af_heart` → (kokoro, af_heart), keeping the older bare names working."""
        engine, sep, name = voice.partition(":")
        if sep and engine in ORDER:
            return engine, name
        if " " in voice:
            return "win", voice
        return "kokoro", voice

    def auto(self, group: str) -> str | None:
        """The best installed voice for a group, as `<engine>:<voice>`."""
        if group not in self._auto:
            found = None
            for e in self.usable():
                try:
                    v = e.best(group_langs(group))
                except Exception as err:
                    log(f"{e.name} can't pick a voice:", err)
                    v = None
                if v:
                    found = f"{e.name}:{v}"
                    break
            self._auto[group] = found
        return self._auto[group]

    def resolve(self, voice: str | None, group: str) -> str:
        """The voice to use: the one asked for when its engine is usable here,
        else the best one installed, else the main group's."""
        if voice and voice != "auto":
            engine, _ = self.split(voice)
            if self.by_name[engine].available()[0]:
                return voice if ":" in voice else f"{engine}:{voice}"
        return self.auto(group) or self.auto("main") or ""

    def synth(self, voice: str, text: str) -> bytes:
        engine, name = self.split(voice)
        return self.by_name[engine].synth(text, name)

    def warm(self, voice: str):
        engine, name = self.split(voice)
        e = self.by_name[engine]
        if e.available()[0]:
            e.warm(name)

    def close(self):
        for e in self.by_name.values():
            try:
                e.close()
            except Exception:
                pass
