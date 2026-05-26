"""
One-shot backfill: for every old coin-affecting log row that doesn't already
have a sibling `field='coins'` row, generate one.

Handles two flavors of legacy rows:
  1. Clean rows: numeric `before`/`after` in their normal columns.
  2. GAS-era corrupted rows: `before`/`after` columns contain action text;
     the real numeric `before` lives in the `detail` column (column-shift bug
     from GAS appendRow / readSheet mismatch). Recovered by reading `detail`.

Behaviors:
- buy / sell (seller) / purchase_apply / purchase_cancel (refund)
  → insert a field='coins' twin row at (timestamp - 1ms).
- rd_ok → ensure a paired `rd_cost` row exists (insert if missing).
- true null/null sell buyer-mirror rows (none currently exist) would be
  reconstructed by walking the country's chronological coin balance.

Idempotent guard: skip if a matching (country_id, event, field='coins') row
already exists within ±2s of the candidate.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

LOG_FILE = Path("D:/project/youthcamp/_log_pre_backfill.json")
OUT_FILE = Path("D:/project/youthcamp/_backfill.sql")

INITIAL_COINS = {"my": 10000, "kr": 10000, "jp": 10000, "us": 20000}
RD_COST = 500

CONTEXT_WINDOW = timedelta(seconds=2)


def parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.rstrip("Z"))


def format_iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds") + "Z"


def sql_literal(v) -> str:
    if v is None or v == "":
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        # Use int form for whole-number floats so the output is clean
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def to_number(v) -> float | None:
    """Try to coerce a value to a float. Return None if it's not numeric."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def row_after_is_coins(r: dict) -> bool:
    """Whether this row's `after` column represents the country's coin balance.
    Used to decide if `running` should track it."""
    ev = r.get("event") or ""
    f = r.get("field") or ""
    if ev == "adjust":
        return f == "coins"
    if ev in ("buy", "sell", "sell_fail", "rd_fail", "rd_cost"):
        return True
    if ev in ("purchase_apply", "purchase_cancel"):
        return True
    if ev == "rd_ok":
        return f == "coins"
    # produce_ok / produce_fail: before/after are product qty
    return False


def recover_before(r: dict) -> float | None:
    """Return the real coin-before value for this row, handling column-shift corruption.

    - If `before` is numeric → use it.
    - If `before` is a non-numeric string (corrupted row) → `detail` contains
      the real before value (as a string of digits).
    - Else None.
    """
    b = r.get("before")
    bn = to_number(b)
    if bn is not None:
        return bn
    if isinstance(b, str):
        # Corrupted GAS row; the real before lives in `detail`
        return to_number(r.get("detail"))
    return None


def main() -> int:
    with LOG_FILE.open(encoding="utf-8") as f:
        data = json.load(f)
    rows = data[0]["results"]
    rows.sort(key=lambda r: (r["timestamp"], r.get("id") or 0))
    print(f"loaded {len(rows)} rows", file=sys.stderr)

    # Index existing field='coins' rows for dedup
    coin_index: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    rd_cost_by_country: dict[str, list[datetime]] = defaultdict(list)
    for r in rows:
        if r.get("field") == "coins":
            coin_index[(r["country_id"], r["event"])].append(parse_iso(r["timestamp"]))
        if r.get("event") == "rd_cost":
            rd_cost_by_country[r["country_id"]].append(parse_iso(r["timestamp"]))

    def has_nearby(country_id: str, event: str, ts: datetime) -> bool:
        for ct in coin_index.get((country_id, event), []):
            if abs((ct - ts).total_seconds()) <= CONTEXT_WINDOW.total_seconds():
                return True
        return False

    def has_nearby_rd_cost(country_id: str, ts: datetime) -> bool:
        for ct in rd_cost_by_country.get(country_id, []):
            if abs((ct - ts).total_seconds()) <= CONTEXT_WINDOW.total_seconds():
                return True
        return False

    # Walk each country's events to reconstruct running balance (for true null
    # mirror rows). Currently no such rows exist, but keep the logic for safety.
    by_country: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        cid = r.get("country_id") or ""
        if cid in INITIAL_COINS:
            by_country[cid].append(r)

    inserts: list[tuple] = []
    updates: list[tuple[int, float, float]] = []
    generated: dict[str, int] = defaultdict(int)
    recovered_from_detail = 0
    skipped_no_data = 0
    skipped_existing = 0

    for cid, country_rows in by_country.items():
        running = INITIAL_COINS[cid]
        for r in country_rows:
            ev = r.get("event") or ""
            ts = parse_iso(r["timestamp"])
            field = r.get("field") or ""
            delta_n = to_number(r.get("delta")) or 0.0

            if ev == "reset":
                running = INITIAL_COINS[cid]
                continue

            # ---- True null/null buyer mirror? (delta < 0, both before & after are real None) ----
            if (ev == "sell" and field != "coins"
                    and r.get("before") is None and r.get("after") is None):
                # Reconstruct from running
                new_before = running
                new_after = new_before + delta_n
                updates.append((r["id"], new_before, new_after))
                running = new_after
                # Also need to insert a coin row for it
                if not has_nearby(cid, "sell", ts):
                    detail = f"💰 (backfill) sell 金币变动 {int(delta_n):+}"
                    inserts.append((
                        format_iso(ts - timedelta(milliseconds=1)),
                        r.get("mentor"), cid, "sell", "coins",
                        delta_n, new_before, new_after, detail, r.get("reason") or "",
                    ))
                    kind = "sell_seller" if delta_n > 0 else "sell_buyer"
                    generated[kind] += 1
                else:
                    skipped_existing += 1
                continue

            # ---- Recover before from the row (handles GAS corruption) ----
            before_n = recover_before(r)
            after_n = before_n + delta_n if before_n is not None else None
            was_recovered = before_n is not None and not isinstance(r.get("before"), (int, float))
            if was_recovered:
                recovered_from_detail += 1

            # Update running balance ONLY when this row's after represents coins.
            # (rd_ok with non-coins prize has after=prize_field; must not pollute.)
            if row_after_is_coins(r) and after_n is not None:
                running = after_n

            # ---- Generate backfill coin row per event type ----
            ts_new = ts - timedelta(milliseconds=1)
            if ev == "buy" and field != "coins":
                if has_nearby(cid, "buy", ts):
                    skipped_existing += 1; continue
                if before_n is None:
                    skipped_no_data += 1; continue
                detail = f"💰 (backfill) buy 金币变动 {int(delta_n):+}"
                inserts.append((format_iso(ts_new), r.get("mentor"), cid, "buy", "coins",
                                delta_n, before_n, after_n, detail, r.get("reason") or ""))
                generated["buy"] += 1

            elif ev == "sell" and field != "coins":
                if has_nearby(cid, "sell", ts):
                    skipped_existing += 1; continue
                if before_n is None:
                    skipped_no_data += 1; continue
                kind = "sell_seller" if delta_n > 0 else "sell_buyer"
                detail = f"💰 (backfill) sell 金币变动 {int(delta_n):+}"
                inserts.append((format_iso(ts_new), r.get("mentor"), cid, "sell", "coins",
                                delta_n, before_n, after_n, detail, r.get("reason") or ""))
                generated[kind] += 1

            elif ev == "purchase_apply" and field != "coins":
                if has_nearby(cid, "purchase_apply", ts):
                    skipped_existing += 1; continue
                if before_n is None:
                    skipped_no_data += 1; continue
                detail = f"💰 (backfill) 申请采购单 {int(delta_n):+} 金币"
                inserts.append((format_iso(ts_new), r.get("mentor"), cid, "purchase_apply", "coins",
                                delta_n, before_n, after_n, detail, r.get("reason") or ""))
                generated["purchase_apply"] += 1

            elif ev == "purchase_cancel" and field != "coins" and delta_n > 0:
                if has_nearby(cid, "purchase_cancel", ts):
                    skipped_existing += 1; continue
                if before_n is None:
                    skipped_no_data += 1; continue
                detail = f"💰 (backfill) 取消采购单退款 {int(delta_n):+} 金币"
                inserts.append((format_iso(ts_new), r.get("mentor"), cid, "purchase_cancel", "coins",
                                delta_n, before_n, after_n, detail, r.get("reason") or ""))
                generated["purchase_cancel"] += 1

            elif ev == "rd_ok":
                # Ensure paired rd_cost exists
                if has_nearby_rd_cost(cid, ts):
                    continue
                cost = RD_COST
                if field == "coins" and before_n is not None:
                    # rd_ok's before = X-cost (post-cost). pre-cost = before+cost.
                    pre, post = before_n + cost, before_n
                    # running was correctly updated above to after_n = X-cost+prize
                elif running is not None:
                    # Non-coins prize. `running` here = X (pre-rd; coin balance
                    # before this rd action). After cost: X-cost. No coin prize.
                    pre, post = running, running - cost
                    running = running - cost  # advance running past the cost
                else:
                    pre, post = None, None
                detail = f"🧪 (backfill) 研发投入 -{cost} 金币"
                inserts.append((format_iso(ts_new), r.get("mentor"), cid, "rd_cost", "coins",
                                -cost, pre, post, detail, r.get("reason") or ""))
                generated["rd_cost"] += 1

    out: list[str] = [
        "-- Auto-generated by backfill_coin_logs.py — DO NOT hand-edit",
        f"-- Inserts {sum(generated.values())} coin-trail rows; updates {len(updates)} buyer-mirror null/null rows.",
        f"-- Recovered before-coins from `detail` for {recovered_from_detail} GAS-corrupted rows.",
        "-- Apply: cd worker && npx wrangler d1 execute youthcamp --remote --file=../_backfill.sql",
        "",
    ]

    for row_id, b, a in updates:
        out.append(
            f'UPDATE log SET "before" = {sql_literal(b)}, '
            f'"after" = {sql_literal(a)} WHERE id = {row_id};'
        )
    if updates:
        out.append("")

    if inserts:
        BATCH = 100  # D1 has SQLITE_TOOBIG limit on single statements
        for start in range(0, len(inserts), BATCH):
            batch = inserts[start : start + BATCH]
            out.append('INSERT INTO log (timestamp, mentor, country_id, event, field, delta, "before", "after", detail, reason) VALUES')
            for i, row in enumerate(batch):
                vals = ", ".join(sql_literal(v) for v in row)
                sep = "," if i < len(batch) - 1 else ";"
                out.append(f"  ({vals}){sep}")

    OUT_FILE.write_text("\n".join(out), encoding="utf-8")
    print(f"\nWrote {OUT_FILE}", file=sys.stderr)
    print(f"  recovered before from `detail` (GAS-corrupted): {recovered_from_detail}", file=sys.stderr)
    print(f"  buyer-mirror null/null fixes (updates): {len(updates)}", file=sys.stderr)
    print(f"  inserts: {sum(generated.values())}", file=sys.stderr)
    for k, v in sorted(generated.items()):
        print(f"    {k}: {v}", file=sys.stderr)
    print(f"  skipped (already had coin row within window): {skipped_existing}", file=sys.stderr)
    print(f"  skipped (no recoverable before value): {skipped_no_data}", file=sys.stderr)
    print(f"\nApply: cd worker && npx wrangler d1 execute youthcamp --remote --file=../_backfill.sql", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
