"""Tracks recent portfolio moves by well-known investors (Buffett/Berkshire,
Ackman/Pershing Square, Burry/Scion) using Claude's server-side web_search
tool. Thinking is left on (adaptive, the Sonnet 5 default) since disabling it
makes the model noticeably less willing to reach for tools.
"""
import logging

from agents.llm import MODEL, get_client
from notify import send_notification

logger = logging.getLogger("alphabot.guru_tracker")

MAX_SEARCH_USES = 8

SYSTEM_PROMPT = (
    "You are AlphaBot's 13F/guru-tracking analyst. You research the most recent publicly "
    "disclosed portfolio moves of well-known investors using web search, then summarize them "
    "for a retail investor. Always search for current information — do not answer from prior "
    "knowledge, since 13F filings and portfolio moves change quarterly and your training data "
    "is stale. Cite what you find (source name is enough, full URLs not required in the summary). "
    "If you cannot find recent information for one of the investors, say so plainly instead of "
    "guessing."
)

PROMPT = """Search the web for the most recent portfolio moves (new positions, added/trimmed
positions, notable sells) for these three investors:

1. Warren Buffett / Berkshire Hathaway (13F filings, recent buys/sells)
2. Bill Ackman / Pershing Square Capital Management
3. Michael Burry / Scion Asset Management

For each investor, give:
- The most recent move(s) you can find, with an approximate date/quarter
- Ticker(s) involved and direction (new position / increased / trimmed / exited)
- One sentence on the likely rationale if reported

Keep the whole summary under 300 words, plain text, organized by investor with a short header
per investor. If a section has no recent news, say so instead of padding."""


def _run_agentic_search(client, messages: list[dict]) -> str:
    """Handles the pause_turn resume loop for the server-side web search tool."""
    max_continuations = 5
    for _ in range(max_continuations):
        response = client.messages.create(
            model=MODEL,
            max_tokens=4000,
            thinking={"type": "adaptive"},
            tools=[{
                "type": "web_search_20260209",
                "name": "web_search",
                "max_uses": MAX_SEARCH_USES,
            }],
            system=SYSTEM_PROMPT,
            messages=messages,
        )

        if response.stop_reason == "pause_turn":
            # Server-side tool loop hit its iteration cap — resend as-is to resume.
            messages.append({"role": "assistant", "content": response.content})
            continue

        if response.stop_reason == "refusal":
            logger.warning("Guru tracker request was refused by safety classifiers")
            return "Zapytanie zostało odrzucone przez klasyfikatory bezpieczeństwa Claude."

        text_parts = [b.text for b in response.content if b.type == "text"]
        return "\n".join(text_parts) if text_parts else "Brak odpowiedzi tekstowej od Claude."

    return "Przekroczono limit iteracji wyszukiwania — spróbuj ponownie później."


def track_gurus() -> str:
    client = get_client()
    messages = [{"role": "user", "content": PROMPT}]
    return _run_agentic_search(client, messages)


def run_gurus_and_notify():
    summary = track_gurus()
    send_notification(
        title="🕵️ Guru Tracker",
        message=summary,
        priority="default",
        tags=["male_detective", "money_with_wings"],
    )
    return summary
