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

## Before making the repository public (v1)

- [ ] Test on macOS (issue #1) and on Linux desktops (issue #2).
- [ ] Lowering other apps beyond WSL: Linux through pactl (#3), macOS partial
      at best (#4). Not needed for v1.
- [ ] A short animation of a reply being read with the highlight, for the README (voice samples and the diagram are in).
- [ ] Version 1.0.0 in plugin.json and the changelog; tag it.
