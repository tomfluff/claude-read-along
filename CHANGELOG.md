# Changelog

## 0.9.0 (unreleased)

The first version prepared for release, renamed from read-aloud.

- Voices from several engines: Kokoro, the macOS voices, the Windows voices
  (from WSL) and eSpeak NG. A voice is written `engine:name`, and `auto` picks
  the best one installed for each language.
- Kokoro can be installed by the plugin itself (`bin/setup.py kokoro`, or ask
  Claude with `/read-along setup`): kokoro-onnx on the CPU, about 1 GB, into
  the plugin's own data folder. An existing Kokoro can be used instead.
- `/read-along doctor` says what works on the machine and what to install;
  `/read-along voices` lists the installed voices; `/read-along restart`.
- Plays through ffplay or SoX, so it runs on macOS and Linux as well as WSL.
- One `voices` setting per language group replaces the six English, Japanese
  and Hebrew voice settings; `player` replaces `controls` and `bottom`;
  `highlight` replaces the two highlight colours; the `python` setting is gone.
- New defaults that suit any terminal: reverse-video highlight, plain-text
  icons, speed 1.25.
- Lowering other apps while reading only shows where it works (WSL).
