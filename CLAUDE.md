# read-along: working on this plugin

A Claude Code mod (hooks module) plus a local speech service. README.md is
the user's guide; this file is for whoever changes the code. The repository
root is the marketplace (`.claude-plugin/marketplace.json`); the plugin itself
is `plugin/`, so the README's media and these notes aren't installed.

## Layout (in `plugin/`)

- `hooks/register.tsx`: the Claude Code side (drawing, commands, settings).
  `types/index.d.ts` declares its `$.state` values.
- `bin/speakd.py`: the speech service (one per user, Unix socket, HTTP).
  Standard library only, so it runs before anything is installed.
- `bin/engines.py`: the voice engines and the platform. Standard library
  only; Kokoro's packages are imported lazily.
- `bin/pocket_worker.py`: Pocket TTS (a voice of one's own), run in its own
  Python with PyTorch; engines.py talks to it in JSON lines.
- `bin/setup.py`: installs Kokoro (kokoro-onnx by default) into the data
  folder, or registers an existing Python.
- `bin/duck.ps1`: lowers other Windows apps' volume (WSL only).
- `skills/setup/SKILL.md`: what Claude follows to set a machine up.

## Checks after a change

```bash
claude plugin validate --strict .           # from the root: marketplace and plugin
claude plugin test plugin                   # the mod's tests (plugin/tests/*.test.tsx)
python3 -m unittest discover -s plugin/tests   # the service's tests
python3 -I plugin/bin/speakd.py --doctor    # on this machine
```

Type-check with the tsconfig from the header of the engine's types file
(the plugin-authoring skill names it), including `hooks`, `types` and `tests`.

The service replaces itself when `speakd.py` or `engines.py` change (it
compares their mtimes), so `/reload-plugins` plus the next read is enough.

## Things learned the hard way

- eSpeak NG ignores a data path longer than 160 characters, and Kokoro's
  packages load eSpeak's data from inside their Python environment, so that
  environment's path must stay short (the data folder, not a deep temp dir).
- misaki's `en` extra pulls in spacy-curated-transformers and with it PyTorch
  (several GB); setup installs misaki without extras plus spacy and the
  spaCy English model directly.
- misaki's Japanese rules look for `unidic`, which needs a 500 MB download;
  engines.py aliases the bundled `unidic_lite` in its place.
- WSLg's PulseAudio crackles below a 300 ms buffer.
- In the hooks module: a `$.clock.every` must start in `session.start`; a mod's
  own `$.command.run` never reaches its own `command.run` hook; leave a child
  out with `cond ? [<X/>] : []`, never `cond && <X/>`; write `$.state` only
  when the value changed (each write redraws its readers).
- The band above the prompt is drawn by the mods in `enabledPlugins` order;
  a mod that answers it without calling `next(e)` hides every mod after it
  (token-weather and replay-theater did). read-along checks for this itself.
- In `claude plugin test`, the test's bottom hooks answer `process.run`,
  `http.fetch`, `ui.toast` and `command.register` as `{ value: ... }`
  (`session.start` as `{ cwd }`); use `mock.env` and `mock.clock` for those.
- Over Remote Control, the Claude phone and desktop apps draw no mods
  (2.1.296): no buttons, toasts or status line. Typed commands work (#6).
- GitHub READMEs play no video or audio from repository files: relative links,
  `<video>` tags, blob or raw URLs and an MP3 renamed to `.mp4` all failed
  (2026-10-11). The README uses a GIF; the web page plays the real files.

## Release 0.9.0 (public preview)

- [x] A short recording of a reply being read with the highlight (`docs/videos/`).
- [x] README, changelog and the web page say only WSL has been tried by hand.
- [x] Make the repository public; tag `v0.9.0` and publish a GitHub release (2026-10-11).
- [x] GitHub Pages from `main`, folder `/docs` (`docs/.nojekyll` keeps it
      as-is). It appears at https://sechayk.com/claude-read-along/ (the user
      site's custom domain); set it as the repository's website and link it
      from the README's top and its "Hear it" section.
- [x] Videos: the web page plays the recordings and samples with their voice;
      the README shows `docs/videos/mouse-example.gif` (made from the
      hover-buttons recording, 1200 px, 8 fps, 48 colours) instead of
      uploaded videos. The originals are in `.drafts/videos/`.

## Before 1.0.0

- [ ] Test on macOS (issue #1) and on Linux desktops (issue #2).
- [ ] Native Windows (#5), which would bring the buttons to the desktop app.
- [ ] Lowering other apps beyond WSL: Linux through pactl (#3), macOS partial
      at best (#4). Not needed for 1.0.
- [ ] Version 1.0.0 in plugin.json and the changelog; tag it.
