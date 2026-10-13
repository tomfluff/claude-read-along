"""Tests for the speech service's pieces that need no audio device.

    python3 -m unittest discover -s tests
"""

import os
import sys
import time
import unittest
import wave
from array import array
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))

import engines  # noqa: E402
import speakd  # noqa: E402

SAY = """\
Albert              en_US    # Hello! My name is Albert.
Samantha            en_US    # Hello! My name is Samantha.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
Kyoko               ja_JP    # こんにちは、私の名前はKyokoです。
Carmit              he_IL    # שלום, שמי כרמית.
Ava (Premium)       en_US    # Hello! My name is Ava.
"""

ESPEAK = """\
Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  af              --/M      Afrikaans          gmw/af
 5  en-us           --/M      English_(America)  gmw/en-US            (en 10)
 5  en              --/M      English_(Great_Britain) gmw/en          (en 2)
 5  he              --/M      Hebrew             sem/he
"""


class Parsing(unittest.TestCase):
    def test_say_voices(self):
        voices = engines.parse_say_voices(SAY)
        self.assertEqual([v["name"] for v in voices], ["Albert", "Samantha", "Eddy (English (US))", "Kyoko", "Carmit", "Ava (Premium)"])
        self.assertEqual(voices[3], {"id": "mac:Kyoko", "name": "Kyoko", "lang": "ja-JP"})

    def test_mac_prefers_premium(self):
        mac = engines.Mac()
        mac._voices = engines.parse_say_voices(SAY)
        mac.available = lambda: (True, "")
        self.assertEqual(mac.best(["en"]), "Ava (Premium)")
        mac._voices = [v for v in mac._voices if "Premium" not in v["name"]]
        self.assertEqual(mac.best(["en"]), "Samantha")
        self.assertEqual(mac.best(["he"]), "Carmit")
        self.assertIsNone(mac.best(["ko"]))

    def test_espeak_voices(self):
        voices = engines.parse_espeak_voices(ESPEAK)
        self.assertEqual([v["lang"] for v in voices], ["af", "en-us", "en", "he"])
        e = engines.Espeak()
        e.exe, e._voices = "espeak-ng", voices
        self.assertEqual(e.best(["en"]), "en-us")
        self.assertEqual(e.best(["he"]), "he")

    def test_windows_prefers_neural_voices(self):
        w = engines.Windows()
        w.available = lambda: (True, "")
        w._voices = [
            {"id": "win:Microsoft Zira Desktop", "name": "Zira", "lang": "en-US"},
            {"id": "win:Microsoft Aria Native", "name": "Aria", "lang": "en-US"},
            {"id": "win:Microsoft Hila Native", "name": "Hila", "lang": "he-IL"},
        ]
        self.assertEqual(w.best(["en"]), "Microsoft Aria Native")
        self.assertEqual(w.best(["he"]), "Microsoft Hila Native")


class Routing(unittest.TestCase):
    def test_script_groups(self):
        self.assertEqual(engines.script_of("Hello there."), "main")
        self.assertEqual(engines.script_of("今日はいい天気ですね。"), "ja")
        self.assertEqual(engines.script_of("中文测试句子"), "zh")
        self.assertEqual(engines.script_of("中文测试句子", {"ja": "kokoro:jf_alpha"}), "ja")
        self.assertEqual(engines.script_of("שלום עולם"), "he")
        self.assertEqual(engines.script_of("Привет мир"), "ru")
        self.assertEqual(engines.script_of("The word שלום in English."), "main")

    def test_voice_names(self):
        split = engines.Engines.split
        self.assertEqual(split("kokoro:af_heart"), ("kokoro", "af_heart"))
        self.assertEqual(split("mac:Eddy (English (US))"), ("mac", "Eddy (English (US))"))
        self.assertEqual(split("af_heart"), ("kokoro", "af_heart"))
        self.assertEqual(split("Microsoft Hila Native"), ("win", "Microsoft Hila Native"))

    def test_resolve_falls_back_when_the_engine_is_missing(self):
        e = engines.Engines()
        for engine in e.by_name.values():
            engine.available = lambda: (False, "test")
        e.by_name["espeak"].available = lambda: (True, "")
        e.by_name["espeak"].best = lambda langs: "en-us"
        self.assertEqual(e.resolve("kokoro:af_heart", "main"), "espeak:en-us")
        self.assertEqual(e.resolve("espeak:he", "he"), "espeak:he")


    def test_pocket_voices_are_its_own_and_the_files_in_its_folder(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            old = {k: os.environ.get(k) for k in ("READ_ALONG_DATA", "LANG", "LC_ALL", "LC_MESSAGES")}
            os.environ.update(READ_ALONG_DATA=data, LANG="de_DE.UTF-8", LC_ALL="", LC_MESSAGES="")
            config = os.path.join(data, "config.json")
            try:
                pocket = engines.Pocket()
                self.assertFalse(pocket.available()[0])  # not installed
                for f in ("me.wav", "me.safetensors", "calm.mp3", "notes.txt"):
                    open(os.path.join(folder, f), "w").close()
                os.mkdir(os.path.join(folder, "samples"))
                with open(config, "w") as f:
                    json.dump({"pocketPython": sys.executable, "pocketVoices": folder}, f)
                self.assertEqual(pocket.available(), (True, ""))
                self.assertEqual(pocket.own(), {"calm": os.path.join(folder, "calm.mp3"), "me": os.path.join(folder, "me.safetensors")})
                voices = pocket.voices()
                self.assertEqual(voices[:3], [{"id": "pocket:calm", "name": "calm", "lang": "de", "own": True},
                                              {"id": "pocket:me", "name": "me", "lang": "de", "own": True},
                                              {"id": "pocket:alba", "name": "alba", "lang": "de"}])
                self.assertEqual(len(voices), 2 + len(engines.POCKET_BUILTIN))
                self.assertEqual(pocket.language(), ("de", "german"))  # the main language, from $LANG
                self.assertIsNone(pocket.best(["de"]))  # never picked by `auto`
                self.assertEqual(engines.Engines.split("pocket:me"), ("pocket", "me"))
                # Installed by setup into the data folder; turned off by setup.py pocket-off.
                os.makedirs(os.path.join(data, "pocket", "bin"))
                open(os.path.join(data, "pocket", "bin", "python"), "w").close()
                with open(config, "w") as f:
                    json.dump({"mainLanguage": "ja"}, f)
                self.assertEqual(pocket.python(), os.path.join(data, "pocket", "bin", "python"))
                self.assertEqual(pocket.language(), ("en", "english"))  # no Japanese model: English
                with open(config, "w") as f:
                    json.dump({"pocket": False}, f)
                self.assertFalse(pocket.available()[0])
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v

class Audio(unittest.TestCase):
    def test_resample_length_and_ends(self):
        src = array("h", [0, 1000, 2000, 3000] * 2205).tobytes()  # 0.4 s at 22050
        out = engines.resample(src, 22050, 24000)
        self.assertEqual(len(out) // 2, int(len(src) // 2 * 24000 / 22050))
        self.assertEqual(engines.resample(src, 24000, 24000), src)

    def test_wav_to_pcm(self):
        buf = BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(array("h", [1, 2, 3, 4]).tobytes())
        self.assertEqual(array("h", engines.wav_to_pcm(buf.getvalue())).tolist(), [1, 3])

    def test_players(self):
        cmd = speakd.player_command("sox", 1.5, 0.5)
        self.assertEqual(cmd[-5:], ["tempo", "-s", "1.500", "vol", "0.50"])
        cmd = speakd.player_command("ffplay", 1.0, 1.0)
        self.assertNotIn("-af", cmd)


class Text(unittest.TestCase):
    def test_speakable(self):
        text = speakd.speakable("**Bold** and [a link](http://x.y) → `code`.\n```\nx = 1\n```", read_code=False)
        self.assertIn("Bold and a link to code.", " ".join(text.split()))
        self.assertIn("(Code block.)", text)

    def test_say_swaps_written_forms_for_spoken_ones(self):
        pairs = speakd.say_pairs([["0.9", "zero point nine"], ["v0.9.1", "version zero point nine point one"],
                                  ["", "x"], ["a"], [1, 2], ["%", "percent"]])
        self.assertEqual(pairs[0][0], "v0.9.1")  # longest first
        self.assertEqual(speakd.spoken("Update to v0.9.1, then 0.9 is 90%.", pairs),
                         "Update to version zero point nine point one, then zero point nine is 90percent.")
        self.assertEqual(speakd.spoken("Nothing here.", []), "Nothing here.")
        self.assertEqual(speakd.say_pairs("not a list"), [])

    def test_sentences(self):
        self.assertEqual(speakd.split_sentences("One. Two! 三つ。四つ"), ["One.", "Two!", "三つ。", "四つ"])


class FakeEngines:
    """Speech of 0.1 s per word, streamed a word at a time."""

    def __init__(self):
        self.made = []

    def resolve(self, voice, group):
        return "fake:v"

    def auto(self, group):
        return None

    def stream(self, voice, text):
        self.made.append(text)
        for _ in text.split():
            yield b"\1\0" * int(engines.RATE * 0.1)

    def synth(self, voice, text):
        return b"".join(self.stream(voice, text))


class Making(unittest.TestCase):
    def player(self):
        p = speakd.Player()
        p.engines = FakeEngines()
        return p

    def test_a_stream_is_heard_in_pieces_and_made_once(self):
        p = self.player()
        job = speakd.Job({"text": "One two three."})
        pieces = []
        audio = p.synth(job, 0, pieces.append)
        self.assertEqual(len(pieces), 3)
        self.assertEqual(b"".join(pieces), audio)
        self.assertAlmostEqual(job.durations[0], 0.3)
        self.assertEqual(p.synth(job, 0, pieces.append), audio)  # from the cache, no pieces
        self.assertEqual((len(pieces), p.engines.made), (3, ["One two three."]))

    def test_the_producer_passes_pieces_then_the_rest(self):
        import queue

        p = self.player()
        job = speakd.Job({"text": "One two. Three."})
        p.synth(job, 1)  # made ahead: comes whole
        out = queue.Queue()
        p._produce(job, 0, p.run_token, out)
        items = []
        while (item := out.get()) is not None:
            items.append((item[0], len(item[1]), item[2]))
        piece = int(engines.RATE * 0.1) * 2
        self.assertEqual(items, [(0, piece, False), (0, piece, False), (0, 0, True), (1, piece, True)])
        self.assertTrue(job.made_all)

    def test_the_next_queued_read_is_made_ahead(self):
        p = self.player()
        now, queued = speakd.Job({"text": "Now."}), speakd.Job({"text": "First. Second. Third."})
        p.job, p.queue = now, [queued]
        p.ahead.set()  # the current read isn't all made yet: nothing happens
        time.sleep(0.2)
        self.assertEqual(p.engines.made, [])
        now.made_all = True
        p.ahead.set()
        for _ in range(50):
            if len(queued.cache) == speakd.AHEAD:
                break
            time.sleep(0.02)
        self.assertEqual(p.engines.made, ["First.", "Second."])


if __name__ == "__main__":
    unittest.main()
