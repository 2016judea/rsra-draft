#!/usr/bin/env python3
"""The paywall's backup, run by hand. Nothing here emails anyone.

    python3 scripts/fulfil.py cs_live_...          # a buyer lost their password: reprint it
    python3 scripts/fulfil.py --recent             # every session of ours since launch, paid or not
    python3 scripts/fulfil.py --comp-pw <label>    # a password that opens ANY property, no Stripe
                                                   # (a test, a press copy); logged to private/comps.csv

The password lives in the session's metadata (minted by api/checkout.js, bound to one
property) and in the invoice footer Stripe emailed the buyer. Reads STRIPE_SECRET_KEY
from ~/Desktop/bricks/.env and ACCESS_SECRET from ./.env (the same value is in Vercel).
"""
import csv, datetime as dt, hashlib, hmac, sys, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://rsra-draft.vercel.app"
ALPHA = "23456789BCDFGHJKMNPQRSTVWXYZ"  # same as api/_lib/pay.js
LAUNCH = 1792022400  # 2026-10-15


def env(path, key):
    for line in Path(path).expanduser().read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"{key} missing from {path}")


def chars(b, n):
    return "".join(ALPHA[x % len(ALPHA)] for x in b[:n])


def comp_password(label):
    s = env(ROOT / ".env", "ACCESS_SECRET").encode()
    nonce = chars(hmac.new(s, ("label:" + label).encode(), hashlib.sha256).digest(), 5)
    raw = nonce + chars(hmac.new(s, ("comp:" + nonce).encode(), hashlib.sha256).digest(), 7)
    return nonce, f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def stripe(path):
    import requests
    j = requests.get(f"https://api.stripe.com/v1/{path}", auth=(env("~/Desktop/bricks/.env", "STRIPE_SECRET_KEY"), "")).json()
    if "error" in j:
        sys.exit(f"stripe: {j['error'].get('message')}")
    return j


def show(s):
    m = s.get("metadata") or {}
    q = {"address": m.get("address", ""), **({"pin": m["pin"]} if m.get("pin") else {}), "pw": m.get("password", "")}
    print(f"{s['id']}\n  status   {s['status']} / {s['payment_status']}  ${(s.get('amount_total') or 0) / 100:.2f}"
          f"\n  email    {(s.get('customer_details') or {}).get('email')}\n  property {m.get('label')}  ({m.get('key')})"
          f"\n  password {m.get('password')}\n  link     {SITE}/?{urllib.parse.urlencode(q)}\n  emailed  {m.get('pw_emailed') or 'NOT YET'}")


if len(sys.argv) < 2:
    sys.exit(__doc__)
arg = sys.argv[1]
if arg == "--comp-pw":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    label = sys.argv[2]
    nonce, pw = comp_password(label)
    log = ROOT / "private/comps.csv"
    log.parent.mkdir(exist_ok=True)
    new = not log.exists()
    with log.open("a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["issued", "label", "nonce"])
        w.writerow([dt.date.today().isoformat(), label, nonce])
    print(f"{label}\n  password {pw}  (opens any property)")
elif arg == "--recent":
    for s in stripe(f"checkout/sessions?limit=100&created[gte]={LAUNCH}")["data"]:
        if (s.get("metadata") or {}).get("product") == "rsra-draft":
            show(s)
else:
    show(stripe(f"checkout/sessions/{arg}"))
