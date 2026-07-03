"""AlphaBot entry point.

Usage:
    python main.py                       # start the scheduler (morning briefing + stop-loss monitor)
    python main.py scan                  # run the scanner once, notify via ntfy
    python main.py research AAPL         # deep-dive on a ticker
    python main.py gurus                 # check recent Buffett/Ackman/Burry moves
    python main.py add AAPL 2 185.50     # add a position: ticker shares buy_price
    python main.py portfolio             # current P&L, notify via ntfy
    python main.py deposit 250           # record a capital deposit, notify via ntfy
    python main.py withdraw 100          # record a cash withdrawal, notify via ntfy
    python main.py balance               # show available capital
    python main.py web                   # local web app at http://localhost:8000
"""
import argparse
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("alphabot.main")


def cmd_scan(_args):
    from agents.scanner import run_scan_and_notify
    run_scan_and_notify()


def cmd_research(args):
    from agents.research import run_research_and_notify
    run_research_and_notify(args.ticker)


def cmd_gurus(_args):
    from agents.guru_tracker import run_gurus_and_notify
    run_gurus_and_notify()


def cmd_add(args):
    from db import add_transaction, get_usd_portfolio_id
    add_transaction(get_usd_portfolio_id(), args.ticker.upper(), "BUY", args.shares, args.price)
    print(f"Dodano pozycję: {args.shares}x {args.ticker.upper()} @ ${args.price:.2f}")


def cmd_portfolio(_args):
    from portfolio import format_portfolio_message, run_portfolio_and_notify
    positions, drawdown, capital = run_portfolio_and_notify()
    print(format_portfolio_message(positions, drawdown, capital))


def cmd_deposit(args):
    from portfolio import add_deposit_and_notify
    capital = add_deposit_and_notify(args.amount)
    print(f"Zapisano wpłatę: ${args.amount:.2f}. Dostępny kapitał: ${capital['available']:.2f}")


def cmd_withdraw(args):
    from portfolio import InsufficientCashError, add_withdrawal_and_notify
    try:
        capital = add_withdrawal_and_notify(args.amount)
    except InsufficientCashError as exc:
        print(exc)
        sys.exit(1)
    print(f"Zapisano wypłatę: ${args.amount:.2f}. Dostępny kapitał: ${capital['available']:.2f}")


def cmd_balance(_args):
    from portfolio import compute_capital_summary
    capital = compute_capital_summary()
    print(f"💵 Wpłacono łącznie: ${capital['total_deposited']:.2f}")
    print(f"📌 Zainwestowano: ${capital['invested']:.2f}")
    print(f"🟢 Dostępny kapitał: ${capital['available']:.2f}")


def cmd_run(_args):
    from scheduler import run_forever
    run_forever()


def cmd_web(args):
    from web.server import run_server
    run_server(port=args.port)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="alphabot", description="AlphaBot — asystent inwestycyjny US")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("scan", help="Odpal scanner ręcznie, wynik idzie przez ntfy").set_defaults(func=cmd_scan)

    p_research = sub.add_parser("research", help="Głęboka analiza spółki")
    p_research.add_argument("ticker", help="Ticker np. AAPL")
    p_research.set_defaults(func=cmd_research)

    sub.add_parser("gurus", help="Ostatnie ruchy Buffetta/Ackmana/Burry'ego").set_defaults(func=cmd_gurus)

    p_add = sub.add_parser("add", help="Dodaj pozycję do portfela")
    p_add.add_argument("ticker")
    p_add.add_argument("shares", type=float)
    p_add.add_argument("price", type=float)
    p_add.set_defaults(func=cmd_add)

    sub.add_parser("portfolio", help="Aktualne P&L portfela").set_defaults(func=cmd_portfolio)

    p_deposit = sub.add_parser("deposit", help="Zapisz wpłatę kapitału")
    p_deposit.add_argument("amount", type=float)
    p_deposit.set_defaults(func=cmd_deposit)

    p_withdraw = sub.add_parser("withdraw", help="Zapisz wypłatę gotówki")
    p_withdraw.add_argument("amount", type=float)
    p_withdraw.set_defaults(func=cmd_withdraw)

    sub.add_parser("balance", help="Pokaż dostępny kapitał").set_defaults(func=cmd_balance)

    p_web = sub.add_parser("web", help="Uruchom lokalną aplikację webową (http://localhost:8000)")
    p_web.add_argument("--port", type=int, default=8000)
    p_web.set_defaults(func=cmd_web)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.command is None:
        cmd_run(args)
        return

    try:
        args.func(args)
    except Exception:
        logger.exception("Command '%s' failed", args.command)
        sys.exit(1)


if __name__ == "__main__":
    main()
