#!/usr/bin/env python3
"""Sets up read-along's Kokoro voices, or points read-along at a Kokoro you
already have. Standard library only; run it with any Python 3.9+.

    setup.py kokoro [--japanese] [--torch]
        Install Kokoro into read-along's own Python (made with uv when it is
        installed, else with venv) in the data folder, and download its model.
        The default is kokoro-onnx: CPU only, about 1 GB on disk with the
        model, and about 3x faster than real time on a laptop CPU.
        --japanese adds Japanese (builds pyopenjtalk; needs cmake and a C
        compiler where pip has no wheel for it).
        --torch installs PyTorch Kokoro instead: GPU when there is one,
        about 2 GB or more.
    setup.py use-python PATH
        Use a Python that already has `kokoro` or `kokoro-onnx` installed.
    setup.py pocket [--python PATH] [--voices FOLDER] [--threads N]
        Optional: Pocket TTS (kyutai-labs/pocket-tts), 27 more voices and
        voices of your own. Installs it into its own Python in the data
        folder (PyTorch on the CPU, about 1 GB), or with --python uses a
        Python that already has it. Your voices go in FOLDER (default: the
        data folder's `voices`), one file each: a recording, or a
        `.safetensors` voice state from `pocket-tts export-voice`.
    setup.py pocket-off
        Stop using Pocket TTS (the files stay; delete the data folder's
        `pocket` folder to free the space).
    setup.py language CODE
        The language of text in Latin script, such as en, es or fr (default:
        from $LANG).
    setup.py show
        Print the data folder and its config.json.

Nothing is installed outside the data folder (~/.local/share/claude-read-along,
or ~/Library/Application Support/claude-read-along on macOS). The model comes
from the kokoro-onnx releases on GitHub and is checked against its SHA-256;
the Python packages come from PyPI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from engines import PLATFORM, data_dir, read_config  # noqa: E402

PYTHON_VERSION = "3.12"  # every package below has wheels for it
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
SPACY_MODEL = ("en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/"
               "en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl")
# misaki without its `en` extra: that extra pulls in spacy-curated-transformers
# and with it PyTorch (several GB), which the onnx path doesn't need.
ONNX_PACKAGES = ["kokoro-onnx==0.6.1", "misaki==0.9.4", "spacy==3.8.16", "num2words==0.5.14", SPACY_MODEL]
TORCH_PACKAGES = ["kokoro==0.9.4", "misaki[en]==0.9.4", SPACY_MODEL]
JAPANESE_PACKAGES = ["fugashi==1.5.2", "jaconv==0.5.0", "mojimoji==0.0.13", "pyopenjtalk==0.4.1", "unidic-lite==1.0.8"]


def say(*parts):
    print(*parts, flush=True)


def write_config(**changes):
    cfg = read_config()
    cfg.update({k: v for k, v in changes.items() if v is not None})
    for k in [k for k, v in changes.items() if v is None]:
        cfg.pop(k, None)
    os.makedirs(data_dir(), exist_ok=True)
    with open(os.path.join(data_dir(), "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def run(cmd, **kw):
    say("$", " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def make_venv(venv: str) -> str:
    python = os.path.join(venv, "bin", "python")
    if os.path.exists(python):
        return python
    if shutil.which("uv"):
        run(["uv", "venv", "--python", PYTHON_VERSION, venv])
    else:
        if not ((3, 10) <= sys.version_info[:2] <= (3, 13)):
            sys.exit(f"Python {sys.version.split()[0]} is too new or old for these packages; "
                     "install uv (https://docs.astral.sh/uv/) and run this again.")
        run([sys.executable, "-m", "venv", venv])
        run([python, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    return python


def pip_install(python: str, packages: list[str], extra: list[str] | None = None):
    if shutil.which("uv"):
        run(["uv", "pip", "install", "--python", python, *(extra or []), *packages])
    else:
        run([python, "-m", "pip", "install", *(extra or []), *packages])


def download_model():
    models = os.path.join(data_dir(), "models")
    os.makedirs(models, exist_ok=True)
    for name, digest in MODEL_FILES.items():
        path = os.path.join(models, name)
        if os.path.exists(path) and sha256(path) == digest:
            continue
        say(f"Downloading {name} …")
        tmp = path + ".part"
        urllib.request.urlretrieve(MODEL_URL + name, tmp)
        if sha256(tmp) != digest:
            os.unlink(tmp)
            sys.exit(f"{name} didn't match its SHA-256; not using it.")
        os.replace(tmp, path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def try_voice(python: str, voices: list[str]) -> bool:
    """Speaks a sentence per voice into memory, in the new Python, and reports the speed."""
    code = (
        "import sys, time; sys.path.insert(0, sys.argv[1]); from engines import Kokoro, RATE\n"
        "k = Kokoro()\n"
        "for v, text in [a.split('=', 1) for a in sys.argv[2:]]:\n"
        "    t = time.time(); pcm = k.synth(text, v); took = time.time() - t\n"
        "    print(f'  {v}: {len(pcm) / 2 / RATE:.1f}s of speech in {took:.1f}s', flush=True)\n"
    )
    samples = {"a": "Read-along is ready.", "j": "読み上げの準備ができました。"}
    args = [f"{v}={samples.get(v[0], samples['a'])}" for v in voices]
    say("Trying the voices (the first one loads the model):")
    return subprocess.run([python, "-I", "-c", code, HERE, *args]).returncode == 0


def setup_kokoro(japanese: bool, torch: bool):
    venv = os.path.join(data_dir(), "venv")
    say(f"Installing Kokoro ({'PyTorch' if torch else 'onnx, CPU'}) into {venv}")
    python = make_venv(venv)
    if torch:
        # Linux wheels from PyPI carry CUDA; without an NVIDIA GPU the CPU build is a fraction of the size.
        extra = []
        if PLATFORM in ("linux", "wsl") and not shutil.which("nvidia-smi"):
            extra = ["--index-url", "https://download.pytorch.org/whl/cpu", "--extra-index-url", "https://pypi.org/simple"]
        pip_install(python, ["torch"], extra)
        pip_install(python, TORCH_PACKAGES)
    else:
        pip_install(python, ONNX_PACKAGES)
        download_model()
    voices = ["af_heart"]
    if japanese:
        try:
            pip_install(python, JAPANESE_PACKAGES)
            voices.append("jf_alpha")
        except subprocess.CalledProcessError:
            say("Japanese didn't install (pyopenjtalk needs cmake and a C compiler here); English works without it.")
    write_config(python=None)  # the venv is found by its place
    ok = try_voice(python, voices)
    say("Kokoro is ready." if ok else "Kokoro installed, but the test sentence failed; see above.")
    return 0 if ok else 1


def use_python(path: str):
    path = os.path.abspath(os.path.expanduser(path))
    probe = "import importlib.util as u; print('torch' if u.find_spec('kokoro') else 'onnx' if u.find_spec('kokoro_onnx') else '')"
    found = subprocess.run([path, "-I", "-c", probe], capture_output=True, text=True).stdout.strip()
    if not found:
        sys.exit(f"{path} has neither kokoro nor kokoro-onnx installed.")
    write_config(python=path)
    say(f"read-along will use {path} (Kokoro {found}).")


POCKET_PACKAGE = "pocket-tts==3.3.0"


def setup_pocket(python: str | None, folder: str | None, threads: int | None):
    if python:
        python = os.path.abspath(os.path.expanduser(python))
        probe = "import importlib.util as u; print('yes' if u.find_spec('pocket_tts') else '')"
        if subprocess.run([python, "-I", "-c", probe], capture_output=True, text=True).stdout.strip() != "yes":
            sys.exit(f"{python} doesn't have Pocket TTS (the pocket_tts package) installed.")
    else:
        venv = os.path.join(data_dir(), "pocket")
        say(f"Installing Pocket TTS into {venv}")
        made = make_venv(venv)
        extra = []
        if PLATFORM in ("linux", "wsl") and not shutil.which("nvidia-smi"):
            # The CPU build of PyTorch, a fraction of the size of the CUDA one.
            extra = ["--index-url", "https://download.pytorch.org/whl/cpu", "--extra-index-url", "https://pypi.org/simple"]
        pip_install(made, ["torch"], extra)
        pip_install(made, [POCKET_PACKAGE])
    folder = os.path.abspath(os.path.expanduser(folder)) if folder else None
    os.makedirs(folder or os.path.join(data_dir(), "voices"), exist_ok=True)
    write_config(pocket=None, pocketPython=python, pocketVoices=folder, pocketThreads=threads)

    from engines import Pocket

    engine = Pocket()
    ok, why = engine.available()
    if not ok:
        sys.exit(f"Pocket TTS isn't usable: {why}")
    own = list(engine.own())
    say(f"Your voices ({engine.folder()}): {', '.join('pocket:' + n for n in own) or 'none yet'}")
    say("Trying it (the first time downloads its model, about 250 MB):")
    try:
        t = time.time()
        engine.synth("Read-along is ready.", "alba")
        took = time.time() - t
        t = time.time()
        pcm = engine.synth("This sentence is timed to see how fast the voice is made.", "alba")
        say(f"  ready in {took:.1f}s; {len(pcm) / 2 / 24000:.1f}s of speech in {time.time() - t:.1f}s")
        if own:
            engine.synth("This is your voice.", own[0])
            say(f"  pocket:{own[0]} works")
    except RuntimeError as err:
        say(f"  failed: {err}")
        return 1
    finally:
        engine.close()
    if not engine.cloning:
        say("Recordings can't be cloned yet: accept the terms at https://huggingface.co/kyutai/pocket-tts, "
            "then log in with `hf auth login`. Built-in voices and saved voice states work without it.")
    say("Choose a voice with /read-along voice pocket:alba, or in the settings.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("kokoro")
    k.add_argument("--japanese", action="store_true")
    k.add_argument("--torch", action="store_true")
    p = sub.add_parser("use-python")
    p.add_argument("path")
    pk = sub.add_parser("pocket")
    pk.add_argument("--python")
    pk.add_argument("--voices")
    pk.add_argument("--threads", type=int)
    sub.add_parser("pocket-off")
    lang = sub.add_parser("language")
    lang.add_argument("code")
    sub.add_parser("show")
    a = ap.parse_args()

    t = time.time()
    if a.cmd == "kokoro":
        code = setup_kokoro(a.japanese, a.torch)
        say(f"Done in {time.time() - t:.0f}s. Restart the speech service: /read-along restart")
        sys.exit(code)
    if a.cmd == "pocket":
        code = setup_pocket(a.python, a.voices, a.threads)
        say(f"Done in {time.time() - t:.0f}s. Restart the speech service: /read-along restart")
        sys.exit(code)
    if a.cmd == "pocket-off":
        write_config(pocket=False, pocketPython=None, pocketVoices=None, pocketThreads=None)
        say("read-along no longer uses Pocket TTS.")
    if a.cmd == "use-python":
        use_python(a.path)
    elif a.cmd == "language":
        write_config(mainLanguage=a.code.lower())
        say(f"Text in Latin script is read as '{a.code.lower()}'.")
    say(f"Data folder: {data_dir()}")
    say(json.dumps(read_config(), indent=2))


if __name__ == "__main__":
    main()
