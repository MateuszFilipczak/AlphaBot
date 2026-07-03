"""Cron jobs: morning briefing (daily 7:00 CET) and stop-loss monitoring
(hourly, 15:30-22:00 CET on trading days — matches US market hours in CET).
"""
import logging

from apscheduler.schedulers.blocking import BlockingScheduler

from agents.scanner import run_morning_briefing
from config import TIMEZONE
from portfolio import check_stop_losses_and_drawdown

logger = logging.getLogger("alphabot.scheduler")


def _safe(job_fn, name: str):
    def wrapped():
        try:
            job_fn()
        except Exception:
            logger.exception("Scheduled job '%s' failed", name)
    return wrapped


def build_scheduler() -> BlockingScheduler:
    scheduler = BlockingScheduler(timezone=TIMEZONE)

    scheduler.add_job(
        _safe(run_morning_briefing, "morning_briefing"),
        trigger="cron",
        hour=7,
        minute=0,
        id="morning_briefing",
        name="Morning briefing",
    )

    scheduler.add_job(
        _safe(check_stop_losses_and_drawdown, "stop_loss_monitor"),
        trigger="cron",
        day_of_week="mon-fri",
        hour="15-22",
        minute=30,
        id="stop_loss_monitor",
        name="Stop-loss / drawdown monitor",
    )

    return scheduler


def run_forever():
    scheduler = build_scheduler()
    logger.info("AlphaBot scheduler started (timezone=%s). Ctrl+C to stop.", TIMEZONE)
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped.")
