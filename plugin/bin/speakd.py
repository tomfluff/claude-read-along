#!/usr/bin/env python3
"""speakd: read-along's local speech service.

One process per user, shared by every Claude Code session, so only one voice
talks at a time. It listens for HTTP on a Unix socket, makes speech with the
engines in engines.py (Kokoro, the Windows or macOS voices, eSpeak NG) and
plays it with ffplay or SoX.

Speech is always made at 1x and sped up while playing (ffmpeg's `atempo`,
SoX's `tempo`): in testing that kept every word clear at 2.5x, where Kokoro's
own `speed` both blurred words and fell short of the asked-for rate.

    speakd.py --ensure     start the service if it isn't running, then exit
    speakd.py --serve      run in the foreground
    speakd.py --stop       ask a running service to exit
    speakd.py --doctor     say what works on this machine and what to install

Only the standard library is needed. The service runs in the Python that
bin/setup.py made for Kokoro when there is one, else in the Python that
started it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn, UnixStreamServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # run with -I, which leaves the script's folder off the path

from engines import GROUP_LANGS, PLATFORM, RATE, Engines, data_dir, log, main_language, read_config, run_powershell, script_of  # noqa: E402

# --ensure replaces a service started from an older copy of these files.
VERSION = str(max(os.stat(os.path.join(HERE, f)).st_mtime_ns for f in ("speakd.py", "engines.py", "pocket_worker.py")))
DEFAULT_SOCKET = f"/tmp/read-along-{os.getuid()}.sock"
SEC_PER_CHAR_1X = 0.068  # first guess, refined from real synthesis
LEAD_IN = 0.3  # seconds of silence opening each run
DUCK_RELEASE = 0.8  # seconds after a read stops before other apps come back up
# The audio buffer. WSLg's PulseAudio bridge crackles below about 300 ms.
LATENCY = 0.3 if PLATFORM == "wsl" else 0.15
PREBUFFER = 1.5  # seconds of speech (as heard) ready before playback starts
# A streaming engine (Pocket TTS) keeps making speech while it plays, so it
# starts sooner: this many 1x seconds per 1x of speed ready.
STREAM_PREBUFFER = 0.5
AHEAD = 2  # sentences of the next queued read made while the current one plays
GAP = b"\0\0" * int(RATE * 0.12)  # breath between sentences


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


def say_pairs(raw) -> list[tuple[str, str]]:
    """The request's `say` list, `[[written, spoken], ...]`, kept to well-formed
    pairs, longest written form first so "v0.9.1" goes before "0.9"."""
    pairs = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, (list, tuple)) and len(item) == 2 and all(isinstance(x, str) for x in item):
            written, spoken = item[0].strip(), item[1].strip()
            if written and len(written) <= 200 and len(spoken) <= 400:
                pairs.append((written, spoken))
    return sorted(pairs, key=lambda p: -len(p[0]))


def spoken(sentence: str, pairs: list[tuple[str, str]]) -> str:
    """The sentence as the voice says it: each written form swapped for its
    spoken one, in one pass, so a swap's words are never swapped again. The
    sentence itself is left as it is, for the highlight to find."""
    if not pairs:
        return sentence
    table = dict(pairs)
    pattern = re.compile("|".join(re.escape(w) for w, _ in pairs))
    return pattern.sub(lambda m: table[m.group(0)], sentence)


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


# ---------------------------------------------------------------- playing

_ffplay_major = None


def ffplay_major() -> int:
    global _ffplay_major
    if _ffplay_major is None:
        try:
            out = subprocess.run(["ffplay", "-version"], capture_output=True, text=True).stdout
            m = re.search(r"version n?(\d+)", out)
            _ffplay_major = int(m.group(1)) if m else 0
        except OSError:
            _ffplay_major = 0
    return _ffplay_major


def find_player() -> str | None:
    """ffplay where there is one (it comes with ffmpeg), else SoX's `play`."""
    if shutil.which("ffplay"):
        return "ffplay"
    if shutil.which("play"):
        return "sox"
    return None


def player_command(kind: str, speed: float, volume: float) -> list[str]:
    """A player reading 16-bit mono PCM at RATE from stdin, sped up without
    changing pitch, at `volume` (1 = as made)."""
    if kind == "ffplay":
        # -ch_layout arrived in FFmpeg 5.1; older ones (Ubuntu 22.04 has 4.4) take -ac.
        layout = ["-ch_layout", "mono"] if ffplay_major() >= 6 else ["-ac", "1"]
        cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet",
               "-f", "s16le", "-ar", str(RATE), *layout, "-i", "pipe:0"]
        filters = []
        if abs(speed - 1.0) > 0.01:
            filters.append(f"atempo={speed:.3f}")
        if abs(volume - 1.0) > 0.01:
            filters.append(f"volume={volume:.2f}")
        return cmd + (["-af", ",".join(filters)] if filters else [])
    cmd = ["play", "-q", "-t", "raw", "-r", str(RATE), "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"]
    if abs(speed - 1.0) > 0.01:
        cmd += ["tempo", "-s", f"{speed:.3f}"]
    if abs(volume - 1.0) > 0.01:
        cmd += ["vol", f"{volume:.2f}"]
    return cmd


def player_env() -> dict:
    env = dict(os.environ)
    if PLATFORM == "wsl":
        env.setdefault("PULSE_SERVER", "unix:/mnt/wslg/PulseServer")
        env["PULSE_LATENCY_MSEC"] = str(int(LATENCY * 1000))
        env["SDL_AUDIODRIVER"] = "pulseaudio"
    return env


# ---------------------------------------------------------------- volume of other apps

class Ducker:
    """Lowers other Windows apps (Spotify, a browser) while a read plays, through
    bin/duck.ps1, which sets each app's own volume in the Windows mixer. It
    follows the player's state: down when a read plays, back DUCK_RELEASE
    seconds after it stops or pauses (no pumping between queued reads), and
    every few seconds while playing it lowers any app that started meanwhile.
    WSLg's own audio (msrdc, which carries this service's speech) is left alone.
    duck.ps1 restores everything when its stdin closes, so a crash here never
    leaves apps quiet. WSL only for now."""

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
            with open(os.path.join(HERE, "duck.ps1"), encoding="utf-8") as f:
                self.proc = run_powershell(f.read())
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
        # A voice per group of languages (main, ja, he, …), each `<engine>:<voice>` or `auto`.
        self.voices = dict(req.get("voices") or {})
        for old, group in (("voice", "main"), ("jaVoice", "ja"), ("heVoice", "he")):  # requests from before groups
            if req.get(old) and group not in self.voices:
                self.voices[group] = req[old]
        self.speed = float(req.get("speed") or 1.0)
        self.volume = float(req.get("volume") if req.get("volume") is not None else 1.0)
        self.duck = float(req.get("duck") if req.get("duck") is not None else 1.0)  # other apps' level; 1 = off
        self.sentences = split_sentences(speakable(req.get("text") or "", bool(req.get("readCode"))))
        # Written forms to say otherwise (numbers, symbols), from the mod's rewrite for speech.
        self.say = say_pairs(req.get("say"))
        self.durations: dict[int, float] = {}  # 1x seconds per sentence, once synthesized
        self.cache: dict[tuple, bytes] = {}
        self.making = threading.Lock()  # one sentence made at a time, so none is made twice
        self.made_all = False  # every sentence from the run's start is made: time to make the next read's


class Player:
    def __init__(self):
        self.engines = Engines()
        self.ducker = Ducker(self) if PLATFORM == "wsl" else None
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
        self.ahead = threading.Event()  # set when the next queued read may be made ahead
        threading.Thread(target=self._make_ahead, daemon=True).start()

    # -- synthesis routing

    def voice_for(self, job, sentence):
        """(group, voice) for a sentence: its script picks the group, the group its voice."""
        group = script_of(sentence, job.voices)
        return group, self.engines.resolve(job.voices.get(group), group)

    def synth(self, job, i, piece=None):
        """Sentence i's speech, made once per voice. `piece`, when given, hears
        the speech in pieces as a streaming engine makes them."""
        sentence = job.sentences[i]
        group, voice = self.voice_for(job, sentence)
        key = (i, voice)
        with job.making:
            if key in job.cache:
                return job.cache[key]
            if not voice:
                raise RuntimeError("no voice installed for this language; see /read-along doctor")
            text = spoken(sentence, job.say)
            parts: list[bytes] = []
            try:
                for part in self.engines.stream(voice, text):
                    parts.append(part)
                    if piece:
                        piece(part)
                audio = b"".join(parts)
            except Exception as err:  # once with the best other voice, then give up on the sentence
                fallback = self.engines.auto(group)
                if parts or not fallback or fallback == voice:  # parts: some of it was heard already
                    raise
                log(f"{voice} failed, using {fallback}:", err)
                self.error = f"{voice} failed ({err}); using {fallback}."
                audio = self.engines.synth(fallback, text)
            job.cache[key] = audio
            seconds = len(audio) / 2 / RATE
            job.durations[i] = seconds
            if len(sentence) > 20:
                self.sec_per_char = 0.8 * self.sec_per_char + 0.2 * (seconds / len(sentence))
            return audio

    def _make_ahead(self):
        """Make the next queued read's opening sentences once the current
        read's are all made, so it starts as soon as the current one ends."""
        while True:
            self.ahead.wait()
            self.ahead.clear()
            while True:
                with self.lock:
                    job = self.queue[0] if self.queue else None
                    if not job or (self.job and not self.job.made_all):
                        break
                    todo = [i for i in range(min(AHEAD, len(job.sentences)))
                            if (i, self.voice_for(job, job.sentences[i])[1]) not in job.cache]
                if not todo:
                    break
                try:
                    self.synth(job, todo[0])
                except Exception as err:  # the read itself will try again, and report it
                    log("making ahead failed:", err)
                    break

    # -- runs: one player process fed sentences from `start` on
    #
    # A producer thread synthesizes ahead into a queue while the run thread
    # feeds the player, so a slow sentence never starves it.

    def _kill_player(self):
        if self.player and self.player.poll() is None:
            try:
                self.player.kill()
            except OSError:
                pass
        self.player = None

    def _produce(self, job, start, token, out):
        """Put (sentence, speech, whole) on `out`: the pieces a streaming engine
        makes as they come, then the rest of the sentence with whole=True."""
        job.made_all = False
        try:
            for i in range(start, len(job.sentences)):
                if token != self.run_token:
                    return
                sent = [0]

                def piece(part, i=i, sent=sent):
                    sent[0] += len(part)
                    out.put((i, part, False))

                audio = self.synth(job, i, piece)
                out.put((i, audio[sent[0]:], True))  # all of it when it came from the cache
        except Exception as err:
            out.put(err)
            return
        if token == self.run_token:  # not a run that was replaced while making its last sentence
            job.made_all = True
            self.ahead.set()
        out.put(None)

    def _run(self, job, start, token):
        import queue

        speed = job.speed
        kind = find_player()
        ready: queue.Queue = queue.Queue()
        pending, buffered, done, streaming = [], 0.0, False, False
        written = 0.0
        heard: set[int] = set()  # sentences whose start is written
        player = None
        try:
            if kind is None:
                raise RuntimeError("no audio player found: install ffmpeg (ffplay) or SoX (play)")
            threading.Thread(target=self._produce, args=(job, start, token, ready), daemon=True).start()
            while True:
                item = ready.get()
                if token != self.run_token:
                    return
                if isinstance(item, Exception):
                    raise item
                if item is None:
                    done = True
                else:
                    i, audio, whole = item
                    streaming = streaming or not whole
                    pending.append((i, audio + GAP if whole else audio))
                    buffered += len(pending[-1][1]) / 2 / RATE
                # Prebuffer: start once PREBUFFER seconds (as heard) are ready, or all of
                # it; a stream once STREAM_PREBUFFER seconds per 1x of speed are.
                if player is None and not done and (
                        buffered < STREAM_PREBUFFER * max(1.0, speed) if streaming else buffered / speed < PREBUFFER):
                    continue
                with self.lock:
                    if token != self.run_token:
                        return
                    if player is None:
                        player = self.player = subprocess.Popen(
                            player_command(kind, speed, job.volume), stdin=subprocess.PIPE, env=player_env(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        player.stdin.write(b"\0\0" * int(RATE * LEAD_IN))
                        self.run_started = time.time() + LATENCY + LEAD_IN / speed
                        self.state = "playing"
                    for i, buf in pending:
                        if i not in heard:
                            heard.add(i)
                            self.run_offsets.append((written, i))
                        written += len(buf) / 2 / RATE
                chunk = b"".join(buf for _, buf in pending)
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
            mode = req.get("mode") or "now"
            # One line per request, so a read that never happened can be traced:
            # a "now" read drops whatever was queued.
            log(f"speak {mode} {job.label or '-'} {job.key or '-'}: {len(job.sentences)} sentences;",
                f"queued before: {len(self.queue)}{' (dropped)' if mode != 'queue' and self.queue else ''}")
            if mode == "queue" and self.job:
                self.queue.append(job)
                self.ahead.set()
            else:
                if mode != "queue":
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
        """Change speed, volume or voices; a running read continues from the
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
                if isinstance(req.get("voices"), dict):
                    job.voices.update(req["voices"])
            if self.job and self.state in ("playing", "loading") and ({"speed", "volume", "voices"} & req.keys()):
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

    def info(self):
        """What this machine offers, so the mod can hide what can't work here."""
        return {
            "platform": PLATFORM,
            "engines": [{"name": n, "label": e.label, "ok": e.available()[0]} for n, e in self.engines.by_name.items()],
            "player": find_player(),
            "canDuck": self.ducker is not None,
            "auto": self.engines.auto("main"),
            "mainLanguage": main_language(),
            "groupLangs": GROUP_LANGS,
        }

    def close(self):
        self.control({"action": "stop"})
        if self.ducker:
            self.ducker.close()
        self.engines.close()


# ---------------------------------------------------------------- the doctor

INSTALL = {
    "player": {"wsl": "sudo apt install ffmpeg", "linux": "install ffmpeg or sox from your distribution",
               "macos": "brew install sox  (or: brew install ffmpeg)"},
    "espeak": {"wsl": "sudo apt install espeak-ng", "linux": "install espeak-ng from your distribution"},
}


def doctor() -> str:
    """A plain report of what works here, and the command for what doesn't."""
    lines = [f"read-along on {PLATFORM}, Python {sys.version.split()[0]} ({sys.executable})",
             f"Data folder: {data_dir()}"]
    player = find_player()
    lines.append(f"Player: {player}" if player else f"Player: none found. Fix: {INSTALL['player'].get(PLATFORM, 'install ffmpeg or sox')}")
    engines = Engines()
    lines.append("Engines:")
    for name, e in engines.by_name.items():
        ok, why = e.available()
        if not ok and why.startswith("only"):
            continue  # another platform's engine
        if ok:
            try:
                voices = e.voices()
                langs = sorted({v["lang"].split("-")[0] for v in voices})
                more = "…" if len(langs) > 12 else ""
                detail = f"{len(voices)} voices ({', '.join(langs[:12])}{more})"
                if name == "kokoro":
                    detail += f", {e.backend()}"  # type: ignore[attr-defined]
            except Exception as err:
                ok, detail = False, f"listing voices failed: {err}"
        else:
            detail = why
            if name == "kokoro":
                detail += ". Fix: ask Claude to set up read-along, or run bin/setup.py"
            elif name == "espeak" and PLATFORM in INSTALL["espeak"]:
                detail += f". Fix: {INSTALL['espeak'][PLATFORM]}"
        lines.append(f"  [{'x' if ok else ' '}] {e.label}: {detail}")
    auto = engines.auto("main")
    lines.append(f"Voice 'auto' picks: {auto}" if auto else "Voice 'auto' picks: nothing yet; install one of the engines above")
    if PLATFORM == "wsl":
        lines.append("Lowering other apps while reading: available")
    return "\n".join(lines)


def service_python() -> str:
    """The Python to serve with: the one setup made (or registered) for Kokoro, else this one."""
    cfg = read_config().get("python")
    if cfg and os.path.exists(cfg):
        return cfg
    venv = os.path.join(data_dir(), "venv", "bin", "python")
    return venv if os.path.exists(venv) else sys.executable


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
                return self._send({"voices": player.engines.voices()})
            if self.path == "/info":
                return self._send(player.info())
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
                    # Load the engines the given voices need, so the first read starts at once.
                    wanted = req.get("voices") if isinstance(req.get("voices"), dict) else {}

                    def warm():
                        for group, voice in wanted.items():
                            try:
                                v = player.engines.resolve(voice, group)
                                if v:
                                    player.engines.warm(v)
                            except Exception as err:
                                log(f"warming {voice} failed:", err)

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


def _request(path, raw, timeout):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path)
        s.sendall(raw)
        data = b""
        while chunk := s.recv(4096):
            data += chunk
        return data
    finally:
        s.close()


def alive(path):
    try:
        return b" 200 " in _request(path, b"GET /ping HTTP/1.0\r\n\r\n", 1)[:20]
    except OSError:
        return False


def ping(path):
    try:
        return json.loads(_request(path, b"GET /ping HTTP/1.0\r\n\r\n", 2).split(b"\r\n\r\n", 1)[1])
    except (OSError, ValueError, IndexError):
        return {}


def stop(path):
    try:
        _request(path, b"POST /quit HTTP/1.0\r\nContent-Length: 0\r\n\r\n", 2)
    except OSError:
        pass


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
    log(f"listening on {path} ({PLATFORM}, {sys.executable})")
    try:
        server.serve_forever()
    finally:
        player.close()
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default=DEFAULT_SOCKET)
    ap.add_argument("--idle-exit", type=int, default=1800, help="seconds idle before exiting (frees memory)")
    ap.add_argument("--log", default=f"/tmp/read-along-{os.getuid()}.log")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--serve", action="store_true")
    g.add_argument("--ensure", action="store_true")
    g.add_argument("--stop", action="store_true")
    g.add_argument("--doctor", action="store_true")
    a = ap.parse_args()

    if a.doctor:
        python = service_python()
        if os.path.realpath(python) != os.path.realpath(sys.executable):
            sys.exit(subprocess.run([python, "-I", os.path.abspath(__file__), "--doctor", "--socket", a.socket]).returncode)
        print(doctor())
        print(f"Service: running ({a.socket})" if alive(a.socket) else "Service: not running (it starts with the first read)")
    elif a.serve:
        serve(a.socket, a.idle_exit)
    elif a.stop:
        if alive(a.socket):
            stop(a.socket)
    else:
        if alive(a.socket):
            if ping(a.socket).get("version") == VERSION:
                print("running")
                return
            stop(a.socket)  # started from an older copy of these files: replace it
            for _ in range(50):
                time.sleep(0.1)
                if not alive(a.socket):
                    break
        logf = open(a.log, "a")
        subprocess.Popen(
            [service_python(), "-I", os.path.abspath(__file__), "--serve", "--socket", a.socket,
             "--idle-exit", str(a.idle_exit)],
            stdin=subprocess.DEVNULL, stdout=logf, stderr=logf, start_new_session=True, close_fds=True,
        )
        for _ in range(150):
            time.sleep(0.1)
            if alive(a.socket):
                print("started")
                return
        print("failed to start; see " + a.log)
        sys.exit(1)


if __name__ == "__main__":
    main()
