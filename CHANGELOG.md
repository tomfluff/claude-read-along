# Changelog

## Unreleased

- A voice of your own: read-along can read with Pocket TTS, which clones a
  voice from a short recording. Point it at a Python with Pocket TTS and a
  folder of voices with `setup.py pocket`; each file is a voice
  (`pocket:<name>`), chosen like any other. `auto` never picks them.

## 0.9.2 (2026-10-13)

- While a nested list item is read, the items after it keep their indent;
  the next deeper item used to jump to the left edge, as if a new list began.

## 0.9.1 (2026-10-11)

The highlight follows more of a reply: formatted lines, web addresses, list
items and tables.

- The line being read keeps its bold, italics, struck-through text and links
  (underlined) under the highlight, in the highlight's one colour; it used to
  turn plain while highlighted.
- A web address in the line being read keeps the highlight's background.
- A list item being read keeps Claude Code's `-` marker, and its wrapped lines
  hang under the text.
- A table row being read is highlighted too: read-along draws the whole table
  in Claude Code's box style with that row on the highlight's background
  (a table too wide for the window keeps Claude Code's drawing, the row in
  bold). Table rows had no highlight before.

## 0.9.0 (2026-10-11)

The first public version, renamed from read-aloud: a preview. Used day to day
on WSL; on Linux and macOS it passes CI but hasn't been tried by hand yet.

- `/read-along doctor` lists the surfaces following the session and what each
  has asked read-along to draw. Over Remote Control, the Claude phone and
  desktop apps show no buttons yet; typed commands work from them
  ([#6](https://github.com/tomfluff/claude-read-along/issues/6)).
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
