#!/usr/bin/env python3
"""speakd: the read-aloud mod's local speech service.

One process per user, shared by every Claude Code session, so only one
voice talks at a time. It listens for HTTP on a Unix socket, synthesizes
with Kokoro (GPU when available) or the Windows SAPI voices, and plays
through WSLg's PulseAudio with SoX.

Speech is always synthesized at 1x and sped up while playing (ffmpeg's
`atempo`): in testing that kept every word intelligible at 2.5x, where
Kokoro's own `speed` both blurred words and fell short of the asked-for rate.

    speakd.py --ensure     start the service if it isn't running, then exit
    speakd.py --serve      run in the foreground
    speakd.py --stop       ask a running service to exit
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn, UnixStreamServer

RATE = 24000
VERSION = str(os.stat(__file__).st_mtime_ns)  # --ensure replaces a service started from an older copy
DEFAULT_SOCKET = f"/tmp/read-aloud-{os.getuid()}.sock"
SEC_PER_CHAR_1X = 0.068  # first guess, refined from real synthesis
LEAD_IN = 0.3  # seconds of silence opening each run
DUCK_RELEASE = 0.8  # seconds after a read stops before other apps come back up
LATENCY = 0.3  # PulseAudio buffer; smaller crackles on the WSLg bridge
PREBUFFER = 1.5  # seconds of speech (as heard) ready before playback starts

KOKORO_VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_nova", "af_sky",
    "af_alloy", "af_jessica", "af_river",
    "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx", "am_adam",
    "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
    "bm_george", "bm_fable", "bm_lewis", "bm_daniel",
    "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
]


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- text prep

FENCE = re.compile(r"^```.*?^```[ \t]*$", re.S | re.M)
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
URL = re.compile(r"https?://\S+")
INLINE_CODE = re.compile(r"`([^`]+)`")
EMPH = re.compile(r"(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1")
SENTENCE_END = re.compile(r"(?<=[.!?。！？])\s+|(?<=[。！？])")


def speakable(text: str, read_code: bool) -> str:
    """Markdown as a listener wants to hear it."""
    if read_code:
        text = re.sub(r"^```.*$", "", text, flags=re.M)
    else:
        text = FENCE.sub("\n(Code block.)\n", text)
    out = []
    for line in text.splitlines():
        s = line.strip()
        if re.fullmatch(r"\|?\s*:?-{2,}.*", s):  # table separator row
            continue
        if s.startswith("|"):
            s = ", ".join(c.strip() for c in s.strip("|").split("|") if c.strip()) + "."
        s = re.sub(r"^#{1,6}\s+", "", s)
        s = re.sub(r"^>\s?", "", s)
        s = re.sub(r"^([-*+]|\d+[.)])\s+", "", s)
        out.append(s)
    text = "\n".join(out)
    text = LINK.sub(r"\1", text)
    text = URL.sub("link", text)
    text = INLINE_CODE.sub(r"\1", text)
    text = EMPH.sub(r"\2", text)
    text = text.replace("→", " to ").replace("←", " from ").replace("—", ", ").replace("–", ", ")
    text = "".join(ch for ch in text if unicodedata.category(ch) != "So")  # emoji, symbols
    return text


def split_sentences(text: str) -> list[str]:
    parts = []
    for para in re.split(r"\n\s*\n|\n", text):
        para = para.strip()
        if not para:
            continue
        for s in SENTENCE_END.split(para):
            s = s.strip()
            while len(s) > 280:  # very long sentences: break at a comma near the middle
                cut = max(s.rfind(", ", 0, 280), s.rfind("; ", 0, 280), s.rfind("、", 0, 280))
                if cut < 80:
                    cut = s.rfind(" ", 0, 280)
                if cut < 80:
                    break
                parts.append(s[: cut + 1].strip())
                s = s[cut + 1 :].strip()
            if re.search(r"\w", s):
                parts.append(s)
    return parts


def script_of(s: str) -> str:
    ja = sum(1 for ch in s if "぀" <= ch <= "ヿ" or "一" <= ch <= "鿿")
    he = sum(1 for ch in s if "֐" <= ch <= "׿")
    letters = sum(1 for ch in s if ch.isalpha()) or 1
    if he / letters > 0.3:
        return "he"
    if ja / letters > 0.2:
        return "ja"
    return "en"


# ---------------------------------------------------------------- engines

class Kokoro:
    def __init__(self):
        self.pipes = {}
        self.lock = threading.Lock()
        self.load_lock = threading.Lock()
        self.error = None

    def _pipe(self, lang):
        with self.load_lock:  # warming and a first read must not both load it
            return self._load(lang)

    def _load(self, lang):
        if lang not in self.pipes:
            if lang == "j":
                # The unidic package here ships without its dictionary; the
                # bundled unidic-lite one serves Japanese G2P (cutlet/fugashi).
                import unidic_lite

                sys.modules.setdefault("unidic", unidic_lite)
                if not hasattr(sys.modules["unidic"], "DICDIR"):
                    sys.modules["unidic"] = unidic_lite
            import torch
            from kokoro import KPipeline

            device = "cuda" if torch.cuda.is_available() else "cpu"
            t = time.time()
            # Share one model across languages: only the G2P differs.
            model = next(iter(self.pipes.values())).model if self.pipes else True
            self.pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=model, device=device)
            log(f"kokoro pipeline '{lang}' on {device} in {time.time() - t:.1f}s")
        return self.pipes[lang]

    def synth(self, text, voice):
        import numpy as np

        lang = voice[0] if voice[:1] in "abjefhipz" else "a"  # Kokoro voices start with their language
        with self.lock:
            pipe = self._pipe(lang)
            chunks = [r.audio.numpy() for r in pipe(text, voice=voice, speed=1.0) if r.audio is not None]
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype="float32")


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

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


class Windows:
    """A long-lived PowerShell worker around System.Speech (the SAPI voices
    Balabolka also uses), writing raw 24 kHz PCM to the Windows temp dir."""

    def __init__(self):
        self.proc = None
        self.tmp = None
        self.lock = threading.Lock()
        self.n = 0

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        enc = base64.b64encode(WIN_WORKER.encode("utf-16-le")).decode()
        self.proc = subprocess.Popen(
            [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1,
        )
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
        with self.lock:
            line = self._ask({"op": "voices"})
        if not line.startswith("VOICES "):
            return []
        return [dict(zip(("name", "culture"), v.split("|"))) for v in line[7:].split(";") if v]

    def synth(self, text, voice):
        import numpy as np

        with self.lock:
            self.n += 1
            name = f"read-aloud-{os.getpid()}-{self.n % 8}.pcm"
            line = self._ask({"text": text, "voice": voice or "", "file": name})
        if not line.startswith("OK "):
            raise RuntimeError(line[4:] or "Windows speech failed")
        win_path = line[3:]
        path = subprocess.run(["wslpath", "-u", win_path], capture_output=True, text=True).stdout.strip()
        data = np.fromfile(path, dtype="<i2").astype("float32") / 32768.0
        try:
            os.unlink(path)
        except OSError:
            pass
        return data


class Ducker:
    """Lowers other Windows apps (Spotify, a browser) while a read plays, through
    bin/duck.ps1, which sets each app's own volume in the Windows mixer. It
    follows the player's state: down when a read plays, back DUCK_RELEASE
    seconds after it stops or pauses (no pumping between queued reads), and
    every few seconds while playing it lowers any app that started meanwhile.
    WSLg's own audio (msrdc, which carries this service's speech) is left alone.
    duck.ps1 restores everything when its stdin closes, so a crash here never
    leaves apps quiet."""

    KEEP = ["msrdc"]

    def __init__(self, player):
        self.player = player
        self.proc = None
        self.level = None  # the level applied, or None while nothing is lowered
        self.last = 0.0
        self.quiet_since = None
        threading.Thread(target=self._loop, daemon=True).start()

    def _ask(self, req):
        if not self.proc or self.proc.poll() is not None:
            src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "duck.ps1"), encoding="utf-8").read()
            enc = base64.b64encode(src.encode("utf-16-le")).decode()
            self.proc = subprocess.Popen(
                [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", bufsize=1,
            )
            if self.proc.stdout.readline().strip() != "READY":
                raise RuntimeError("the Windows volume helper didn't start")
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline().strip()
        if line.startswith("ERR"):
            raise RuntimeError(line[4:])
        return line

    def _loop(self):
        while True:
            time.sleep(0.25)
            try:
                job, state = self.player.job, self.player.state
                # Only once speech plays: a cold start can spend seconds loading Kokoro.
                want = job.duck if job and state == "playing" and job.duck < 0.999 else None
                now = time.time()
                if want is not None:
                    self.quiet_since = None
                    if self.level != want or now - self.last > 3:
                        self._ask({"op": "duck", "level": want, "keep": self.KEEP})
                        self.level, self.last = want, now
                elif self.level is not None:
                    self.quiet_since = self.quiet_since or now
                    if now - self.quiet_since >= DUCK_RELEASE:
                        self._ask({"op": "restore"})
                        self.level = None
            except Exception as err:
                log("ducking failed:", err)
                self.player.error = f"Couldn't lower other apps: {err}"
                time.sleep(5)

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self._ask({"op": "restore"})
            except Exception:
                pass
            self.proc.stdin.close()
            self.proc.wait(timeout=10)


# ---------------------------------------------------------------- playback

class Job:
    def __init__(self, req):
        self.id = req.get("id") or f"job-{time.time():.0f}"
        self.label = req.get("label") or ""
        self.key = req.get("key") or ""  # the mod's handle on the source message
        # One voice per language, each a Kokoro name (af_heart, jf_alpha) or
        # `win:<Windows voice name>` (win:Microsoft Nanami Native).
        self.voice = req.get("voice") or "af_heart"
        self.ja_voice = req.get("jaVoice") or "win:Microsoft Nanami Native"
        self.he_voice = req.get("heVoice") or "win:Microsoft Hila Native"
        self.speed = float(req.get("speed") or 1.0)
        self.volume = float(req.get("volume") if req.get("volume") is not None else 1.0)
        self.duck = float(req.get("duck") if req.get("duck") is not None else 1.0)  # other apps' level; 1 = off
        self.sentences = split_sentences(speakable(req.get("text") or "", bool(req.get("readCode"))))
        self.durations: dict[int, float] = {}  # 1x seconds per sentence, once synthesized
        self.cache: dict[tuple, object] = {}


class Player:
    def __init__(self):
        self.kokoro = Kokoro()
        self.windows = Windows()
        self.ducker = Ducker(self)
        self.lock = threading.RLock()
        self.job: Job | None = None
        self.queue: list[Job] = []
        self.state = "idle"  # idle | loading | playing | paused
        self.index = 0  # sentence being heard
        self.run_token = 0
        self.player = None
        self.run_started = 0.0  # wall clock when this run's audio began
        self.run_offsets: list[tuple[float, int]] = []  # (1x seconds into the run, sentence index)
        self.error = None
        self.sec_per_char = SEC_PER_CHAR_1X
        self.last_active = time.time()

    # -- synthesis routing

    def voice_for(self, job, sentence):
        script = script_of(sentence)
        voice = {"he": job.he_voice, "ja": job.ja_voice}.get(script, job.voice)
        if voice.startswith("win:"):
            return ("windows", voice[4:])
        if " " in voice:  # a bare Windows voice name
            return ("windows", voice)
        return ("kokoro", voice)

    def synth(self, job, i):
        sentence = job.sentences[i]
        engine, voice = self.voice_for(job, sentence)
        key = (i, engine, voice)
        if key not in job.cache:
            try:
                audio = (self.kokoro if engine == "kokoro" else self.windows).synth(sentence, voice)
            except Exception as err:  # fall back to Windows once, then give up on the sentence
                if engine == "kokoro":
                    log("kokoro failed, using Windows voice:", err)
                    self.error = f"Kokoro failed ({err}); using the Windows voice."
                    audio = self.windows.synth(sentence, "")
                else:
                    raise
            job.cache[key] = audio
            seconds = len(audio) / RATE
            job.durations[i] = seconds
            if len(sentence) > 20:
                self.sec_per_char = 0.8 * self.sec_per_char + 0.2 * (seconds / len(sentence))
        return job.cache[key]

    # -- runs: one player process fed sentences from `start` on
    #
    # A producer thread synthesizes ahead into a queue while the run thread
    # feeds the player, so a slow sentence (a Windows voice) never starves it.
    # Playback is ffplay over WSLg's PulseAudio with a 300 ms buffer: the
    # default buffer crackles on the RDP audio bridge, 300 ms plays clean.

    def _kill_player(self):
        if self.player and self.player.poll() is None:
            try:
                self.player.kill()
            except OSError:
                pass
        self.player = None

    def _produce(self, job, start, token, out):
        try:
            for i in range(start, len(job.sentences)):
                if token != self.run_token:
                    return
                out.put((i, self.synth(job, i)))
        except Exception as err:
            out.put(err)
            return
        out.put(None)

    def _run(self, job, start, token):
        import queue

        import numpy as np

        speed = job.speed
        cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet",
               "-f", "f32le", "-ar", str(RATE), "-ch_layout", "mono", "-i", "pipe:0"]
        filters = []
        if abs(speed - 1.0) > 0.01:
            filters.append(f"atempo={speed:.3f}")
        if abs(job.volume - 1.0) > 0.01:
            filters.append(f"volume={job.volume:.2f}")
        if filters:
            cmd += ["-af", ",".join(filters)]
        env = dict(os.environ)
        env.setdefault("PULSE_SERVER", "unix:/mnt/wslg/PulseServer")
        env["PULSE_LATENCY_MSEC"] = str(int(LATENCY * 1000))
        env["SDL_AUDIODRIVER"] = "pulseaudio"

        ready: queue.Queue = queue.Queue()
        threading.Thread(target=self._produce, args=(job, start, token, ready), daemon=True).start()
        pad = np.zeros(int(RATE * 0.12), dtype="float32")  # breath between sentences
        pending, buffered, done = [], 0.0, False
        written = 0.0
        player = None
        try:
            while True:
                item = ready.get()
                if token != self.run_token:
                    return
                if isinstance(item, Exception):
                    raise item
                if item is None:
                    done = True
                else:
                    i, audio = item
                    pending.append((i, np.concatenate([audio.astype("float32"), pad])))
                    buffered += len(pending[-1][1]) / RATE
                # Prebuffer: start once PREBUFFER seconds (as heard) are ready, or all of it.
                if player is None and not done and buffered / speed < PREBUFFER:
                    continue
                with self.lock:
                    if token != self.run_token:
                        return
                    if player is None:
                        player = self.player = subprocess.Popen(cmd, stdin=subprocess.PIPE, env=env,
                                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        player.stdin.write(np.zeros(int(RATE * LEAD_IN), dtype="float32").tobytes())
                        self.run_started = time.time() + LATENCY + LEAD_IN / speed
                        self.state = "playing"
                    for i, buf in pending:
                        self.run_offsets.append((written, i))
                        written += len(buf) / RATE
                chunk = b"".join(buf.tobytes() for _, buf in pending)
                pending = []
                try:
                    player.stdin.write(chunk)
                    player.stdin.flush()
                except (BrokenPipeError, ValueError):
                    return
                if done:
                    break
            if player:
                player.stdin.close()
                player.wait()
        except Exception as err:
            log("run failed:", repr(err))
            with self.lock:
                self.error = str(err)
        finally:
            with self.lock:
                if token == self.run_token and self.state in ("playing", "loading"):
                    self._finish_locked()

    def _finish_locked(self):
        self._kill_player()
        self.job = None
        self.state = "idle"
        self.last_active = time.time()
        if self.queue:
            self._start_locked(self.queue.pop(0), 0)

    def _start_locked(self, job, start):
        self.run_token += 1
        self._kill_player()
        self.job = job
        self.index = start
        self.state = "loading"
        self.run_offsets = []
        self.run_started = 0.0
        self.error = None
        self.last_active = time.time()
        if not job.sentences:
            self._finish_locked()
            return
        threading.Thread(target=self._run, args=(job, start, self.run_token), daemon=True).start()

    # -- position

    def _position_locked(self):
        """(sentence index heard now, 1x seconds into the job)."""
        job = self.job
        if not job:
            return 0, 0.0
        if self.state != "playing" or not self.run_offsets:
            i = self.index
            return i, sum(self._dur(job, k) for k in range(i))
        heard = (time.time() - self.run_started) * job.speed  # 1x seconds into this run
        i = self.run_offsets[0][1]
        base = 0.0
        for off, idx in self.run_offsets:
            if off <= heard:
                i, base = idx, off
        self.index = i
        before = sum(self._dur(job, k) for k in range(i))
        within = min(heard - base, self._dur(job, i))
        return i, before + max(0.0, within)

    def _dur(self, job, i):
        return job.durations.get(i, len(job.sentences[i]) * self.sec_per_char) + 0.12

    # -- API

    def speak(self, req):
        job = Job(req)
        with self.lock:
            if req.get("mode") == "queue" and self.job:
                self.queue.append(job)
            else:
                if req.get("mode") != "queue":
                    self.queue.clear()
                self._start_locked(job, 0)
        return self.status()

    def control(self, req):
        action = req.get("action")
        with self.lock:
            job = self.job
            if action == "stop":
                self.queue.clear()
                self.run_token += 1
                self._kill_player()
                self.job, self.state = None, "idle"
                self.last_active = time.time()
            elif not job:
                pass
            elif action in ("pause", "toggle") and self.state in ("playing", "loading"):
                i, _ = self._position_locked()
                self.run_token += 1
                self._kill_player()
                self.index, self.state = i, "paused"
            elif action in ("resume", "toggle") and self.state == "paused":
                self._start_locked(job, self.index)
            elif action == "restart":
                self._start_locked(job, 0)
            elif action in ("back", "forward"):
                i, _ = self._position_locked()
                i = max(0, i - 1) if action == "back" else i + 1
                if i >= len(job.sentences):
                    self._finish_locked()
                else:
                    self._start_locked(job, i)
            elif action == "skip":
                self._finish_locked()
        return self.status()

    def set(self, req):
        """Change speed, voice or engine; a running read continues from the
        sentence being heard, in the new settings."""
        with self.lock:
            jobs = ([self.job] if self.job else []) + self.queue
            for job in jobs:
                if "speed" in req:
                    job.speed = max(0.5, min(4.0, float(req["speed"])))
                if "volume" in req:
                    job.volume = max(0.0, min(2.0, float(req["volume"])))
                if "duck" in req:  # applied live by the ducker, no restart
                    job.duck = max(0.0, min(1.0, float(req["duck"])))
                for k, attr in (("voice", "voice"), ("jaVoice", "ja_voice"), ("heVoice", "he_voice")):
                    if req.get(k) is not None:
                        setattr(job, attr, req[k])
            if self.job and self.state in ("playing", "loading") and ({"speed", "volume", "voice", "jaVoice", "heVoice"} & req.keys()):
                i, _ = self._position_locked()
                self._start_locked(self.job, i)
        return self.status()

    def status(self):
        with self.lock:
            job = self.job
            if not job:
                return {"state": "idle", "queue": len(self.queue), "error": self.error}
            i, pos = self._position_locked()
            total = sum(self._dur(job, k) for k in range(len(job.sentences)))
            i = min(i, len(job.sentences) - 1)
            return {
                "state": self.state,
                "id": job.id,
                "key": job.key,
                "label": job.label,
                "sentence": i,
                "sentences": len(job.sentences),
                "text": job.sentences[i],
                "position": round(pos / job.speed, 2),  # wall-clock seconds, at the current speed
                "total": round(total / job.speed, 2),
                "speed": job.speed,
                "volume": job.volume,
                "voice": self.voice_for(job, job.sentences[i])[1],
                "queue": len(self.queue),
                "error": self.error,
            }


# ---------------------------------------------------------------- HTTP over a Unix socket

class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True


def make_handler(player: Player, server_ref):
    class Handler(BaseHTTPRequestHandler):
        def address_string(self):
            return "local"

        def log_message(self, *args):
            pass

        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_GET(self):
            if self.path == "/status":
                return self._send(player.status())
            if self.path == "/voices":
                try:
                    win = player.windows.voices()
                except Exception as err:
                    win, player.error = [], f"Windows voices unavailable: {err}"
                return self._send({"kokoro": KOKORO_VOICES, "windows": win})
            if self.path == "/ping":
                return self._send({"ok": True, "pid": os.getpid(), "version": VERSION})
            self._send({"error": "not found"}, 404)

        def do_POST(self):
            try:
                req = self._body()
                if self.path == "/speak":
                    return self._send(player.speak(req))
                if self.path == "/control":
                    return self._send(player.control(req))
                if self.path == "/set":
                    return self._send(player.set(req))
                if self.path == "/warm":
                    # Load the Kokoro pipelines the given voices need, so the first read starts at once.
                    langs = {v[0] for v in req.get("voices") or ["af_heart"] if v and not v.startswith("win:") and " " not in v}

                    def warm():
                        for lang in sorted(langs):
                            try:
                                player.kokoro._pipe(lang)
                            except Exception as err:
                                log(f"warming '{lang}' failed:", err)

                    threading.Thread(target=warm, daemon=True).start()
                    return self._send({"ok": True})
                if self.path == "/quit":
                    player.control({"action": "stop"})
                    self._send({"ok": True})
                    threading.Thread(target=server_ref[0].shutdown, daemon=True).start()
                    return
                self._send({"error": "not found"}, 404)
            except Exception as err:
                log("request failed:", repr(err))
                self._send({"error": str(err)}, 500)

    return Handler


def alive(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        s.connect(path)
        s.sendall(b"GET /ping HTTP/1.0\r\n\r\n")
        return b"200" in s.recv(64)
    except OSError:
        return False
    finally:
        s.close()


def ping(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(path)
        s.sendall(b"GET /ping HTTP/1.0\r\n\r\n")
        data = b""
        while chunk := s.recv(4096):
            data += chunk
        return json.loads(data.split(b"\r\n\r\n", 1)[1])
    except (OSError, ValueError, IndexError):
        return {}
    finally:
        s.close()


def stop(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(path)
        s.sendall(b"POST /quit HTTP/1.0\r\nContent-Length: 0\r\n\r\n")
        s.recv(64)
    except OSError:
        pass
    finally:
        s.close()


def serve(path, idle_exit):
    if os.path.exists(path):
        if alive(path):
            log("already running")
            return
        os.unlink(path)
    player = Player()
    ref = [None]
    server = Server(path, make_handler(player, ref))
    ref[0] = server
    os.chmod(path, 0o600)

    def watchdog():
        while True:
            time.sleep(30)
            if player.state == "idle" and time.time() - player.last_active > idle_exit:
                log(f"idle for {idle_exit}s, exiting")
                server.shutdown()
                return

    threading.Thread(target=watchdog, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    log("listening on", path)
    try:
        server.serve_forever()
    finally:
        player.control({"action": "stop"})
        player.ducker.close()
        if player.windows.proc:
            player.windows.proc.kill()
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default=DEFAULT_SOCKET)
    ap.add_argument("--idle-exit", type=int, default=1800, help="seconds idle before exiting (frees VRAM)")
    ap.add_argument("--log", default=f"/tmp/read-aloud-{os.getuid()}.log")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--serve", action="store_true")
    g.add_argument("--ensure", action="store_true")
    g.add_argument("--stop", action="store_true")
    a = ap.parse_args()

    if a.serve:
        serve(a.socket, a.idle_exit)
    elif a.stop:
        if alive(a.socket):
            stop(a.socket)
    else:
        if alive(a.socket):
            if ping(a.socket).get("version") == VERSION:
                print("running")
                return
            stop(a.socket)  # started from an older copy of this file: replace it
            for _ in range(50):
                time.sleep(0.1)
                if not alive(a.socket):
                    break
        logf = open(a.log, "a")
        subprocess.Popen(
            [sys.executable, "-I", os.path.abspath(__file__), "--serve", "--socket", a.socket,
             "--idle-exit", str(a.idle_exit)],
            stdin=subprocess.DEVNULL, stdout=logf, stderr=logf, start_new_session=True, close_fds=True,
        )
        for _ in range(100):
            time.sleep(0.1)
            if alive(a.socket):
                print("started")
                return
        print("failed to start; see " + a.log)
        sys.exit(1)


if __name__ == "__main__":
    main()
