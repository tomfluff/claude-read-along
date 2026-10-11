# Changelog

## 0.9.0 (2026-10-11)

The first public version, renamed from read-aloud: a preview. Used day to day
on WSL; on Linux and macOS it passes CI but hasn't been tried by hand yet.

- Remote Control: on the Claude mobile app the message buttons show without
  hovering, and a read's progress shows under its message, as the phone has no
  player band. `/read-along doctor` lists the surfaces following the session
  and what each has asked read-along to draw.
- When another mod hides the player above the prompt (one listed before
  read-along in `enabledPlugins` that draws there without passing the band
  on), read-along says so once, shows the player on the line under the
  prompt meanwhile, and `/read-along doctor` reports it.
- "Read thinking updates" (off by default; `/read-along auto thinking on`):
  with auto-read `all`, also read Claude's thinking, for setups that show it
  as updates in the transcript, where a step can show only thinking before its
  tool call.
- Auto-read (`all`) reads each of Claude's updates as soon as its text is
  written, rather than once the step's tool call has streamed in, which for a
  long command or file came a minute late and never for a step cut short.

- Voices from several engines: Kokoro, the macOS voices, the Windows voices
  (from WSL) and eSpeak NG. A voice is written `engine:name`, and `auto` picks
  the best one installed for each language.
- Kokoro can be installed by the mod itself (`bin/setup.py kokoro`, or ask
  Claude with `/read-along setup`): kokoro-onnx on the CPU, about 1 GB, into
  the mod's own data folder. An existing Kokoro can be used instead.
- `/read-along doctor` says what works on the machine and what to install;
  `/read-along voices` lists the installed voices; `/read-along restart`.
- Plays through ffplay or SoX, so it runs on macOS and Linux as well as WSL.
- One `voices` setting per language group replaces the six English, Japanese
  and Hebrew voice settings; `player` replaces `controls` and `bottom`;
  `highlight` replaces the two highlight colours; the `python` setting is gone.
- New defaults that suit any terminal: reverse-video highlight, plain-text
  icons, speed 1.25.
- Lowering other apps while reading only shows where it works (WSL).
