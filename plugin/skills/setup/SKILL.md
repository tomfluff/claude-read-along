---
name: setup
description: Set up or troubleshoot the read-along plugin's voices on this machine (install Kokoro, an audio player, or system voices; point it at an existing Kokoro). Use when the person asks to set up read-along, when /read-along doctor shows something missing, or when read-along is silent or says no voice is installed.
---

# Setting up read-along

read-along speaks through a small local service (`bin/speakd.py`) that uses
whatever voices the machine has. It works with no setup when there is an
audio player and at least one engine; Kokoro is optional and sounds much
better. Everything runs locally: the only downloads are the Python packages
(from PyPI) and Kokoro's model (from GitHub, checked against its SHA-256).

The plugin's folder is the one that holds this skill, two levels up
(`<plugin>/skills/setup/SKILL.md`). Its scripts are in `<plugin>/bin/`.

## 1. See what the machine has

Run the doctor and read its report with the person:

```bash
python3 -I <plugin>/bin/speakd.py --doctor
```

It names the platform (wsl, linux, macos), the audio player, each engine with
its voices, and a "Fix:" line for each thing missing. Read it before
installing anything.

## 2. Fix what's missing, asking first

Ask before every install, saying what it is and roughly how big. Never use
sudo without the person's okay, and on a shared or managed machine suggest
they run the command themselves (`! <command>` at the prompt).

- **No audio player.** WSL or Debian/Ubuntu: `sudo apt install ffmpeg`.
  macOS: `brew install sox` (or `brew install ffmpeg`). Other Linux: the
  distribution's ffmpeg or sox package.
- **No engine at all** (Linux without eSpeak, and no Kokoro):
  `sudo apt install espeak-ng`, or install Kokoro below.
- **Kokoro** (recommended; natural voices for English, Japanese, Chinese,
  Spanish, French, Hindi, Italian and Portuguese). Offer it, with its size:
  about 1 GB on disk with the model, runs on the CPU at about 3x real time.

  ```bash
  python3 -I <plugin>/bin/setup.py kokoro            # English and the Latin-script languages
  python3 -I <plugin>/bin/setup.py kokoro --japanese # also Japanese
  ```

  It uses `uv` when installed (and offer to install uv first if it's missing
  and the person's Python is 3.14 or newer: `curl -LsSf https://astral.sh/uv/install.sh | sh`,
  or `brew install uv`). Japanese builds `pyopenjtalk`, which needs cmake and
  a C compiler where there's no wheel; if it fails, English still works.
  Installs can take a few minutes; run the command in the background and wait
  for it rather than polling.

  For an NVIDIA GPU, `--torch` installs PyTorch Kokoro instead (2 GB or
  more). Only suggest it if the person asks for GPU speed.
- **Kokoro already installed elsewhere** (the person has a Python with
  `kokoro` or `kokoro-onnx`): `python3 -I <plugin>/bin/setup.py use-python /path/to/python`.
- **Better system voices.** macOS: System Settings → Accessibility → Spoken
  Content → System Voice → Manage Voices; the Enhanced and Premium voices are
  free downloads. Windows (from WSL): Settings → Time & language → Speech →
  Add voices.
- **Text in Latin script isn't English** (a Spanish or French speaker):
  `python3 -I <plugin>/bin/setup.py language es`.

## 3. Check it

1. Ask the person to run `/read-along restart` so the service picks up the
   changes, then run the doctor again and confirm what changed.
2. Ask them to press the play button on a message, or run `/read-along read`.
3. If it's silent, look at the service log, `/tmp/read-along-$(id -u).log`
   (it says which voice failed and why).

## 4. Choosing voices

`/read-along` opens the settings: a voice per language, speed, volume and
auto-read. `/read-along voices` lists every installed voice by name. The
`voices` setting in `/config` keeps the choices: `main=kokoro:af_heart,
mac:Samantha; ja=kokoro:jf_alpha` (the first of each list is used, and the
voice button steps through the main list). `auto` picks the best voice
installed for each language.

## What not to do

- Don't install anything without asking, or outside what's listed here.
- Don't edit `~/.claude/settings.json` by hand to set voices; the settings
  pane and `/config` do it.
- Don't download other text-to-speech models or services.
