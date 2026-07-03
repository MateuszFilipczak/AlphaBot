"""Loads configuration from .env. Never hardcode secrets here."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
NTFY_TOPIC = os.getenv("NTFY_TOPIC", "")
NTFY_URL = os.getenv("NTFY_URL", "https://ntfy.sh")

MONTHLY_BUDGET_USD = float(os.getenv("MONTHLY_BUDGET_USD", "250"))
MAX_POSITIONS = int(os.getenv("MAX_POSITIONS", "5"))
MAX_DRAWDOWN_PCT = float(os.getenv("MAX_DRAWDOWN_PCT", "15"))
STOP_LOSS_PCT = float(os.getenv("STOP_LOSS_PCT", "8"))

# ALPHABOT_DB override exists for tests (point at a temp file); normal runs
# always use alphabot.db next to the code.
DB_PATH = Path(os.getenv("ALPHABOT_DB", BASE_DIR / "alphabot.db"))

# Claude model used across all agents. Sonnet 5 gives near-Opus quality on
# analysis/agentic tasks at a fraction of the cost, which matters against a
# fixed MONTHLY_BUDGET_USD.
CLAUDE_MODEL = "claude-sonnet-5"

TIMEZONE = "Europe/Warsaw"  # follows CET/CEST with DST, matches the brief
