#!/usr/bin/env python3
"""Rewrite GAME_GUIDE.md / MENTOR_GUIDE.md tables using the latest data
pulled from the Apps Script WebApp (saved as _live_data.json by an upstream
curl call), then regenerate the PDFs via md2pdf.py."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DATA = json.loads((ROOT / "_live_data.json").read_text(encoding="utf-8"))


def get_config(key, default=None):
    for c in DATA["config"]:
        if str(c.get("key")) == key:
            return c.get("value")
    return default


# -------- Build the replacement table strings --------

def love_table_md(limit=None):
    """Markdown table of LoveTable. limit=N → only first N + last row."""
    rows = list(DATA["love_table"])
    if limit and len(rows) > limit:
        head = rows[:limit]
        tail = rows[-1]
        if tail not in head:
            head.append(tail)
        rows = head
    lines = ["| ❤️ 爱心 | 倍数 | 说明 |", "|---|---|---|"]
    for r in rows:
        mult = r.get("multiplier")
        try:
            mstr = f"{float(mult):.2f}"
        except (TypeError, ValueError):
            mstr = str(mult)
        lines.append(f"| {r.get('love')} | {mstr} | {r.get('note') or ''} |")
    return "\n".join(lines)


def level_up_md():
    """Group level_up rows by to_level → one row per to_level in display table.
    to_level=5 rows = "🏆 Lv.4 终极完成" goal (level 字段不会真升到 5)."""
    by_level = {}
    for r in DATA["level_up"]:
        by_level.setdefault(int(r["to_level"]), []).append(r)
    lines = ["| 升级 / 目标 | 需要 |", "|---|---|"]
    for lvl in sorted(by_level):
        conds = by_level[lvl]
        parts = []
        for c in conds:
            need = c.get("need")
            try:
                need_str = f"{int(float(need)):,}" if float(need) >= 1000 else str(int(float(need)))
            except (TypeError, ValueError):
                need_str = str(need)
            parts.append(f"{c.get('label')} ≥ {need_str}")
        label = "🏆 Lv.4 终极完成" if lvl == 5 else f"Lv.{lvl-1} → Lv.{lvl}"
        lines.append(f"| {label} | {', '.join(parts)} |")
    return "\n".join(lines)


def level_up_full_md():
    """Full LevelUp table (one row per condition) for MENTOR_GUIDE.
    to_level=5 rows are shown — they represent the Lv.4 完成 (victory) goal."""
    lines = ["| to_level | key | label | need | note |",
             "|---|---|---|---|---|"]
    for r in DATA["level_up"]:
        lines.append(
            f"| {r.get('to_level')} | {r.get('key')} | {r.get('label')} | "
            f"{r.get('need')} | {r.get('note') or ''} |"
        )
    return "\n".join(lines)


def config_md():
    """MENTOR_GUIDE Config table — show all rows from the live sheet,
    minus keys that are no longer used (Lv.5 was removed)."""
    DROP_KEYS = {"purchase_limit_l5", "purchase_limit"}  # legacy / dead keys
    lines = ["| key | 当前值 | 含义 |", "|---|---|---|"]
    for r in DATA["config"]:
        key = str(r.get("key") or "").strip()
        if key in DROP_KEYS:
            continue
        v = r.get("value")
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        lines.append(f"| `{key}` | {v} | {r.get('note') or ''} |")
    return "\n".join(lines)


def rd_prizes_md():
    lines = ["| 奖品 | 权重 | 说明 |", "|---|---|---|"]
    total = sum(float(r.get("weight") or 0) for r in DATA["rd_prizes"])
    for r in DATA["rd_prizes"]:
        w = r.get("weight")
        pct = (float(w) / total * 100) if total else 0
        lines.append(
            f"| {r.get('label')} | {w} ({pct:.0f}%) | {r.get('note') or ''} |"
        )
    return "\n".join(lines)


def purchase_limit_inline():
    """Inline string like 'Lv.1 → 2 张 · Lv.2 → 3 张 · ...' (Lv.1-4 only)."""
    parts = []
    for lvl in [1, 2, 3, 4]:
        v = get_config(f"purchase_limit_l{lvl}")
        if v is None:
            continue
        try:
            v = int(float(v))
        except (TypeError, ValueError):
            pass
        parts.append(f"Lv.{lvl} → {v} 张")
    return " · ".join(parts)


def resource_price_inline():
    res = next((p for p in DATA["prices"]
                if p.get("item_type") == "resource" and p.get("item_key") == "water"),
               None)
    if not res:
        return "标准 100 单位 / 500 金币;日本 100 单位 / 450 金币 (-10%)"
    unit = res.get("unit_size", 100)
    price = res.get("price", 500)
    price_jp = res.get("price_jp", 450)
    return f"标准 {unit} 单位 / {price} 金币;日本 {unit} 单位 / {price_jp} 金币"


# -------- Splice the markdown sources --------

def replace_block(src, start_pattern, end_pattern, new_block, label=""):
    """Replace text between (inclusive) start_pattern and end_pattern with new_block.
    start_pattern matches the first line of the block; end_pattern is the line
    AFTER the block (kept intact)."""
    m_start = re.search(start_pattern, src, flags=re.MULTILINE)
    if not m_start:
        print(f"  ! [{label}] start pattern not found, skip")
        return src
    rest = src[m_start.start():]
    m_end = re.search(end_pattern, rest, flags=re.MULTILINE)
    if not m_end:
        print(f"  ! [{label}] end pattern not found after start, skip")
        return src
    before = src[:m_start.start()]
    after = rest[m_end.start():]
    print(f"  ✓ [{label}] replaced")
    return before + new_block + "\n\n" + after


def refresh_game_guide():
    path = ROOT / "GAME_GUIDE.md"
    md = path.read_text(encoding="utf-8")

    # Resource unit price line (Section 2)
    md = re.sub(
        r"\*\*单价:\*\* [^\n]+",
        f"**单价:** {resource_price_inline()} (单价随 Google Sheet `Prices` 表变化)。",
        md, count=1,
    )

    # Step 1 purchase-limit inline string (Section 3 Step 1)
    md = re.sub(
        r"同时持有采购单上限随国家等级提升: \*\*[^*]+\*\*",
        f"同时持有采购单上限随国家等级提升: **{purchase_limit_inline()}**",
        md, count=1,
    )

    # Section 5 LevelUp table — header is either old "| 升级 | 需要 |" or
    # new "| 升级 / 目标 | 需要 |" (since to_level=5 = 终极完成 was re-added).
    md = replace_block(
        md,
        r"^\| 升级( / 目标)? \| 需要[^\n]*\|\s*$",
        r"^\s*\n(##|---)\s",  # next blank line + heading/hr
        level_up_md(),
        label="GAME §5 LevelUp",
    )

    # Section 6 LoveTable — replace from "| ❤️ 爱心 |" to the next "> 💡" callout.
    # Show ALL rows from the sheet (no truncation) — sampling earlier
    # produced a confusing "5 → 15" jump that looked like the 6-14 rows
    # didn't exist. Now matches MENTOR_GUIDE §8 (also full table).
    md = replace_block(
        md,
        r"^\s*\|\s*❤️\s*爱心\s*\|\s*倍数\s*\|[^\n]*$",
        r"^>\s+💡\s+\*\*爱心",
        "\n" + love_table_md(),
        label="GAME §6 LoveTable",
    )

    path.write_text(md, encoding="utf-8")
    print("  → GAME_GUIDE.md updated")


def refresh_mentor_guide():
    path = ROOT / "MENTOR_GUIDE.md"
    md = path.read_text(encoding="utf-8")

    # Section 4 purchase order — limit description (inline)
    md = re.sub(
        r"\*\*同时持有上限随国家等级递增\*\*: [^\n]+(?=\(在 Config)",
        f"**同时持有上限随国家等级递增**: {purchase_limit_inline()} ",
        md, count=1,
    )

    # Section 7 Config table — pattern matches either the original 4-col
    # template OR our previously-generated 3-col table.
    md = replace_block(
        md,
        r"^\| key \| (默认 \| 含义 \| 何时改|当前值 \| 含义) \|\s*$",
        r"^---\s*$",
        config_md(),
        label="MENTOR §7 Config",
    )

    # Section 8 LoveTable (default table) — same dual-pattern trick.
    md = replace_block(
        md,
        r"^\| (love \| multiplier|❤️ 爱心 \| 倍数 \| 说明) \|\s*$",
        r"^\*\*阶梯函数:\*\*",
        love_table_md(),
        label="MENTOR §8 LoveTable",
    )

    # Section 8a LevelUp table
    md = replace_block(
        md,
        r"^\| to_level \| key \| label \| need \| note \|\s*$",
        r"^\*\*支持的 key\*\*",
        level_up_full_md(),
        label="MENTOR §8a LevelUp",
    )

    path.write_text(md, encoding="utf-8")
    print("  → MENTOR_GUIDE.md updated")


def main():
    print("Refreshing guides from _live_data.json …")
    print(f"  data updated_at: {DATA.get('updated_at')}")
    print(f"  mentor identity: {DATA.get('mentor_identity')}")
    print()
    print("[GAME_GUIDE]")
    refresh_game_guide()
    print()
    print("[MENTOR_GUIDE]")
    refresh_mentor_guide()
    print()
    print("Running md2pdf.py …")
    r = subprocess.run([sys.executable, str(ROOT / "md2pdf.py")],
                       cwd=str(ROOT))
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
