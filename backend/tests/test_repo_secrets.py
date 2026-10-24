"""Secret scanning of git-tracked files (acceptance criterion: no secrets in source control)."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = {
    "telegram_bot_token": re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b"),
    "anthropic_key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "private_key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "aws_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "generic_assignment": re.compile(r"(?im)^(?:LLM_API_KEY|MEXC_API_KEY|MEXC_API_SECRET|TELEGRAM_BOT_TOKEN|FRED_API_KEY|SERVICE_TOKEN|SESSION_SECRET)=(?!$|change-me|<)(\S{8,})"),
}
ALLOW = {"backend/tests/conftest.py"}  # contains obviously fake test tokens


def tracked_files() -> list[Path]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    return [ROOT / f for f in out]


def test_no_secrets_in_tracked_files():
    hits = []
    for p in tracked_files():
        rel = str(p.relative_to(ROOT))
        if rel in ALLOW or not p.is_file() or p.stat().st_size > 2_000_000:
            continue
        txt = p.read_text(errors="ignore")
        for name, rx in PATTERNS.items():
            if rx.search(txt):
                hits.append((rel, name))
    assert not hits, hits


def test_env_files_not_tracked():
    names = [p.name for p in tracked_files()]
    assert ".env" not in names
