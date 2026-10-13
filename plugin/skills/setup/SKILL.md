---
name: setup
description: Set up or troubleshoot the read-along plugin's voices on this machine (install Kokoro, Pocket TTS, an audio player, or system voices; point it at an existing Kokoro or Pocket TTS; a voice of the person's own). Use when the person asks to set up read-along, when /read-along doctor shows something missing, or when read-along is silent or says no voice is installed.
---

# Setting up read-along

read-along speaks through a small local service (`bin/speakd.py`) that uses
whatever voices the machine has. It works with no setup when there is an
audio player and at least one engine; Kokoro is optional and sounds much
better; Pocket TTS is a further option. Everything runs locally: the only
downloads are the Python packages (from PyPI), Kokoro's model (from GitHub,
checked against its SHA-256) and, with Pocket TTS, its model and built-in
voices (from Hugging Face, on first use).

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
- **Pocket TTS** (optional; offer it after Kokoro, as a yes-or-no question).
  Kyutai's model: 27 more voices (`pocket:alba`, `pocket:marius`, …) in the
  main language when it's English, French, German, Italian, Portuguese,
  Spanish or Dutch, and voices of the person's own, cloned from a recording.
  About 1.3 GB (PyTorch for the CPU, and the model), about 3x real time on 4 threads. `auto`
  never picks it; the person chooses its voices.

  ```bash
  python3 -I <plugin>/bin/setup.py pocket                          # installs it in the data folder
  python3 -I <plugin>/bin/setup.py pocket --python /path/to/python # a Python that already has pocket_tts
  ```

  Setup tries a built-in voice and says whether cloning works. Run it in the
  background too. For a voice of their own:
  - The recording goes in the data folder's `voices` folder (setup prints
    it), one file per voice, 10 to 30 seconds of clear speech; `me.wav`
    becomes `pocket:me` after `/read-along restart`.
  - Cloning needs Hugging Face access to Kyutai's gated model: a free
    account, the terms accepted at https://huggingface.co/kyutai/pocket-tts,
    and `hf auth login` on the machine. The person does those steps; never
    ask for or handle their token. Built-in voices work without it.
  - Say plainly: clone only their own voice or one whose owner agreed.
    Kyutai's terms forbid cloning anyone without explicit consent.
- **Text in Latin script isn't English** (a Spanish or French speaker):
  `python3 -I <plugin>/bin/setup.py language es`.

## 3. Check it

1. Ask the person to run `/read-along restart` so the service picks up the
   changes, then run the doctor again and confirm what changed.
2. Ask them to press the play button on a message, or run `/read-along read`.
3. If it's silent, look at the service log, `/tmp/read-along-$(id -u).log`
   (it says which voice failed and why).
4. After the next reply, ask them to run `/read-along doctor` in the session
   and read its last line, "Player above the prompt". If it says hidden,
   another mod listed before read-along in `enabledPlugins`
   (`~/.claude/settings.json`) draws the band without passing it on. Explain
   that, and offer two fixes: move the `"read-along@claude-read-along": true`
   line above that mod (only with their okay, changing nothing else in the
   file, then `/reload-plugins`), or set `player` to `hint` in `/read-along`.

## 4. Choosing voices

`/read-along` opens the settings: a voice per language, speed, volume and
auto-read. `/read-along voices` lists every installed voice by name. The
`voices` setting in `/config` keeps the choices: `main=kokoro:af_heart,
mac:Samantha; ja=kokoro:jf_alpha` (the first of each list is used, and the
voice button steps through the main list). `auto` picks the best voice
installed for each language; Pocket TTS voices are only ever chosen by hand.

## What not to do

- Don't install anything without asking, or outside what's listed here.
- Don't edit `~/.claude/settings.json` by hand to set voices; the settings
  pane and `/config` do it.
- Don't download other text-to-speech models or services.
