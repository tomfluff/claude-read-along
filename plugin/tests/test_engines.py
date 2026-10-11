"""Tests for the speech service's pieces that need no audio device.

    python3 -m unittest discover -s tests
"""

import os
import sys
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

    def test_sentences(self):
        self.assertEqual(speakd.split_sentences("One. Two! 三つ。四つ"), ["One.", "Two!", "三つ。", "四つ"])


if __name__ == "__main__":
    unittest.main()
