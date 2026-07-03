"""ntfy.sh notification sender.

Uses ntfy's JSON publish API (POST to the base URL with a JSON body) rather
than header-based publishing, since headers don't reliably carry UTF-8
emoji/Polish characters — the JSON body does.
"""
from __future__ import annotations

import logging

import requests

from config import NTFY_TOPIC, NTFY_URL

logger = logging.getLogger("alphabot.notify")

_PRIORITY_MAP = {
    "min": 1,
    "low": 2,
    "default": 3,
    "high": 4,
    "urgent": 5,
}


def send_notification(title: str, message: str, priority: str = "default", tags: list[str] | None = None):
    """Send a push notification via ntfy.sh. Never raises — logs and returns on failure."""
    if not NTFY_TOPIC or NTFY_TOPIC == "tu_wklej_temat_z_ntfy":
        logger.warning("NTFY_TOPIC not configured — printing notification instead")
        print(f"\n[{title}]\n{message}\n")
        return

    payload = {
        "topic": NTFY_TOPIC,
        "title": title,
        "message": message,
        "priority": _PRIORITY_MAP.get(priority, 3),
    }
    if tags:
        payload["tags"] = tags

    try:
        resp = requests.post(NTFY_URL.rstrip("/"), json=payload, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.error("Failed to send ntfy notification: %s", exc)
        print(f"\n[NOTIFY FAILED] {title}\n{message}\n")
