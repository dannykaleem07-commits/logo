import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CALLPILOT_HOME", str(tmp_path / "home"))
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "DEEPL_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    from callpilot.core.crypto import Vault

    Vault._session_vault = None
    yield
    Vault._session_vault = None


os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
