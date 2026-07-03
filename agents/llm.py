"""Shared Anthropic client. Reads the API key from config (which reads .env) —
never hardcode a key anywhere that imports this module.
"""
from __future__ import annotations

import anthropic

from config import ANTHROPIC_API_KEY, CLAUDE_MODEL

_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        if not ANTHROPIC_API_KEY or ANTHROPIC_API_KEY == "tu_wklej_klucz":
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Add it to .env before running AlphaBot."
            )
        _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _client


MODEL = CLAUDE_MODEL
