#!/usr/bin/env python3
"""Generate per-country player guides (GAME_GUIDE_<ID>.md + .pdf).

Each country's guide = GAME_GUIDE.md + country-specific appendix listing:
  - L1/L2/L3/L4 recipes for that country (resources + semi-products)
  - Buy / sell / asset prices for each product
  - Who can buy each level via the 🛒 bank

Run after refreshing _live_data.json (curl the WebApp with ?mentor=<token>).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

# Reuse the converter from md2pdf.py
sys.path.insert(0, str(Path(__file__).parent))
import md2pdf  # type: ignore

ROOT = Path(__file__).parent
DATA = json.loads((ROOT / "_live_data.json").read_text(encoding="utf-8"))

COUNTRY_META = {
    "my": {"flag": "🇲🇾", "name": "马来西亚", "domain": "Energy · Resources"},
    "kr": {"flag": "🇰🇷", "name": "韩国",     "domain": "Tech · AI"},
    "jp": {"flag": "🇯🇵", "name": "日本",     "domain": "Medical · Healthcare"},
    "us": {"flag": "🇺🇸", "name": "美国",     "domain": "Finance · Defense · Space"},
}

RES_LABEL = {
    "water": "💧 水",
    "oil": "🛢 石油",
    "wood": "🪵 木材",
    "metal": "⚙️ 金属",
    "electricity": "⚡ 电力",
    "chips": "💎 晶片",
}
RES_KEYS = list(RES_LABEL.keys())

# 获取方式 — 银行 🛒 / 跨国 💸 谈判 / 本国生产
BUY_NOTE = {
    1: "🔒 银行可买 (仅本国 L1)",
    2: "🌐 银行可买 (任意国家, Lv.2+ 解锁)",
    3: "🌐 银行可买 (任意国家, Lv.3+ 解锁)",
    4: "❌ **只能本国生产** (银行不卖, 跨国也不卖)",
}


def fmt_int(v):
    try:
        n = int(float(v))
        return f"{n:,}"
    except (TypeError, ValueError):
        return str(v) if v != "" else "—"


def recipe_cost_line(r):
    """Compose a 'water 100 · oil 200 · 半成品 X, Y' string for a recipe row."""
    parts = []
    for k in RES_KEYS:
        v = r.get(k)
        if v and v != "" and int(v) > 0:
            parts.append(f"{RES_LABEL[k].split(' ')[1]} {int(v)}")
    semis = [str(r.get(f"semi{i}") or "").strip() for i in range(1, 5)]
    semis = [s for s in semis if s]
    if semis:
        parts.append("半成品: " + ", ".join(semis))
    return " · ".join(parts) if parts else "—"


def price_for(name):
    return next((p for p in DATA["prices"] if p.get("item_key") == name), None)


def country_recipes(cid):
    rows = [r for r in DATA["recipes"]
            if str(r.get("country", "")).lower() == cid]
    rows.sort(key=lambda r: (int(r.get("level", 0)), r.get("name", "")))
    return rows


def manufacturing_section(cid):
    """Render §10: 我国制造手册 — L1..L4 recipe tables."""
    lines = [f"## 10. 🏭 {COUNTRY_META[cid]['flag']} {COUNTRY_META[cid]['name']} · 我的制造手册", ""]
    lines.append("以下是你国家所有产品的配方。开局先看 L1 — 那是你能自给自足的基本盘。"
                 "L2/L3 配方里的「半成品」列就是你需要先做出 (或从别国买) 的低级产品。")
    lines.append("")
    rows = country_recipes(cid)
    by_lvl = {1: [], 2: [], 3: [], 4: []}
    for r in rows:
        lvl = int(r.get("level", 0))
        if lvl in by_lvl:
            by_lvl[lvl].append(r)
    for lvl in [1, 2, 3, 4]:
        items = by_lvl[lvl]
        if not items:
            continue
        lines.append(f"### L{lvl} 产品 ({len(items)} 个)")
        lines.append("")
        lines.append("| 产品 | 配方 (资源 + 半成品) |")
        lines.append("|---|---|")
        for r in items:
            lines.append(f"| **{r['name']}** | {recipe_cost_line(r)} |")
        lines.append("")
    return "\n".join(lines)


def pricing_section(cid):
    """Render §11: 销售 / 估值参考 — per-product price table."""
    meta = COUNTRY_META[cid]
    lines = [f"## 11. 💰 {meta['flag']} {meta['name']} · 销售 / 估值参考", ""]
    lines.append("- **银行采购价 (price)** — 其他国家通过 🛒 银行买你的产品付的价 (L2/L3 跨国可买)")
    lines.append("- **银行回收价 (sell_price)** — 你做出来卖给银行 (🏦) 的固定收益")
    lines.append("- **估值 (asset_value)** — 库存里这件产品计入「总资产」的金额 (×爱心倍数后影响排名)")
    lines.append("- **买家** — 谁可以通过 🛒 银行直接买这件产品")
    lines.append("")
    rows = country_recipes(cid)
    by_lvl = {1: [], 2: [], 3: [], 4: []}
    for r in rows:
        lvl = int(r.get("level", 0))
        if lvl in by_lvl:
            by_lvl[lvl].append(r)
    for lvl in [1, 2, 3, 4]:
        items = by_lvl[lvl]
        if not items:
            continue
        lines.append(f"### L{lvl} 产品")
        lines.append("")
        lines.append("| 产品 | 银行采购价 | 银行回收价 | 估值 | 买家 |")
        lines.append("|---|---|---|---|---|")
        for r in items:
            p = price_for(r["name"]) or {}
            lines.append(
                f"| **{r['name']}** | {fmt_int(p.get('price'))} | "
                f"{fmt_int(p.get('sell_price'))} | {fmt_int(p.get('asset_value'))} | "
                f"{BUY_NOTE.get(lvl, '—')} |"
            )
        lines.append("")
    # Country-specific notes
    if cid == "kr":
        lines.append("> 🇰🇷 **KR L1 加成:** L1 的 `sell_price=2300` (其他国家是 2000), "
                     "即 KR 自己做 L1 卖给银行多 15% 收入。")
    if cid == "jp":
        lines.append("> 🇯🇵 **JP 买资源减免:** 你买基础资源单价 450 (其他国家 500), -10%。"
                     "但你卖产品的 `sell_price` 跟其他国家一样,没有销售加成。")
    return "\n".join(lines)


def strategy_overview_section(cid):
    """Render a brief "你能做什么 / 你需要什么" summary."""
    rows = country_recipes(cid)
    if not rows:
        return ""
    # 找到该国 L1 用到的资源 (用于"起手能做什么")
    l1_res_needed = set()
    for r in rows:
        if int(r.get("level", 0)) == 1:
            for k in RES_KEYS:
                if r.get(k) and int(r[k]) > 0:
                    l1_res_needed.add(k)
    # 找到所有半成品依赖的"外国"产品名
    own_names = {r["name"] for r in rows}
    external_semis = set()
    for r in rows:
        for i in range(1, 5):
            s = str(r.get(f"semi{i}") or "").strip()
            if s and s not in own_names:
                external_semis.add(s)
    lines = [f"## 9. 🎯 {COUNTRY_META[cid]['flag']} {COUNTRY_META[cid]['name']} · 起手速查", ""]
    lines.append(f"**起手就能做的 L1 资源**: " + ", ".join(
        RES_LABEL[k] for k in RES_KEYS if k in l1_res_needed
    ) + " — 其他资源等到 L2 / L3 / L4 才用到")
    if external_semis:
        lines.append("")
        lines.append("**需要跨国买/谈的半成品** (你的 L2-L4 配方里出现, 但不是本国产品):")
        # 反查每个 external semi 的来源国
        for s in sorted(external_semis):
            src = next((rr for rr in DATA["recipes"]
                       if rr.get("name") == s), None)
            if not src:
                lines.append(f"- {s} (来源未知)")
                continue
            src_cid = str(src.get("country", "")).lower()
            src_lvl = int(src.get("level", 0))
            src_meta = COUNTRY_META.get(src_cid, {})
            buy_path = (
                "可走 🛒 银行直接买" if src_lvl in (2, 3) else
                "🛒 只能本国买 (跨国走 💸 谈判)" if src_lvl == 1 else
                "需要走 💸 谈判"
            )
            lines.append(
                f"- **{s}** — 来自 {src_meta.get('flag', '🏳')} "
                f"{src_meta.get('name', src_cid.upper())} (L{src_lvl}); {buy_path}"
            )
    lines.append("")
    return "\n".join(lines)


def get_config(key, default=None):
    for c in DATA["config"]:
        if str(c.get("key")) == key:
            return c.get("value")
    return default


def example_l1_for(cid):
    """Pick a representative L1 product for this country for examples."""
    rows = [r for r in DATA["recipes"]
            if str(r.get("country", "")).lower() == cid
            and int(r.get("level", 0)) == 1]
    return rows[0] if rows else None


def example_l2_for(cid):
    rows = [r for r in DATA["recipes"]
            if str(r.get("country", "")).lower() == cid
            and int(r.get("level", 0)) == 2]
    return rows[0] if rows else None


def resource_unit_cost(cid):
    """Resource unit cost for this country (JP = 450, others = 500)."""
    res = next((p for p in DATA["prices"]
                if p.get("item_type") == "resource" and p.get("item_key") == "water"),
               None)
    if not res:
        return (100, 500, 500)
    unit = int(res.get("unit_size") or 100)
    std = int(res.get("price") or 500)
    jp = int(res.get("price_jp") or std)
    actual = jp if cid == "jp" and jp > 0 else std
    return (unit, std, actual)


def operations_section(cid):
    """Render §12: 5 个操作 — 用统一的「条件 / 机制 / 例子 / 前后对比」表格化排版。
    每个动作的小节结构:
      ┌────────────────────────────┐
      │ ## 12.X 🛒 / 📋 / 🏭 / 💸 / 🎁 │  小节标题
      ├────────────────────────────┤
      │ #### 📋 条件 (Markdown 表)   │  统一三列: # / 条件 / 说明
      │ #### 🎲 机制 (如有, 二列)    │  骰点 / 结果
      │ #### 🎯 例子 (步骤表)        │  # / 操作 / 结果
      │ #### 📊 前后对比 (delta 表)  │  项 / 前 / 后
      │ #### ⚠️ 失败分支 (简短引用)  │
      └────────────────────────────┘
    """
    meta = COUNTRY_META[cid]
    purchase_cost = int(float(get_config("purchase_cost", 100) or 100))
    rd_cost = int(float(get_config("rd_cost", 500) or 500))
    rd_fail = float(get_config("rd_fail_rate", 0.3) or 0.3)
    rd_succ = 1.0 - rd_fail
    po_limits = []
    for lvl in [1, 2, 3, 4]:
        v = get_config(f"purchase_limit_l{lvl}")
        if v is None:
            v = {1: 2, 2: 3, 3: 5, 4: 5}[lvl]
        po_limits.append(int(float(v)))
    unit, std_price, my_price = resource_unit_cost(cid)
    jp_note = " · 🇯🇵 已享 -10% 减免" if cid == "jp" else ""

    l1 = example_l1_for(cid)
    l2 = example_l2_for(cid)

    blocks = []  # markdown 行

    # ============================================================
    # 标题 + 引导
    # ============================================================
    blocks += [
        f"## 12. ⚙️ {meta['flag']} {meta['name']} · 5 个操作清单",
        "",
        "这一节把游戏循环里 5 个动作的**执行条件**和**例子**用统一表格列出。",
        "带去现场对着照做就行 — 每个动作都有 ① 条件清单, ② 骰子/机制规则, ③ 一个分步例子, ④ 前后对比表。",
        "",
        "---",
        "",
    ]

    # ============================================================
    # 12.1 🛒 银行采购
    # ============================================================
    blocks += [
        "### 12.1 🛒 银行采购 — 买资源 / L1 / L2 / L3",
        "",
        "#### 📋 条件 (全部满足)",
        "",
        "| # | 条件 | 说明 |",
        "|---|---|---|",
        "| 1 | 💰 足够金币 | 单价 × 数量 ≤ 当前金币 |",
        "| 2 | 🔑 足够 Level | 资源 Lv.1+ · L1 Lv.2+ · L2 Lv.3+ · L3 Lv.4 (超等级的 tab 显示 🔒) |",
        "| 3 | 🌐 产品归属 | L1 仅本国; L2/L3 任意国家 (会标来源 chip); L4 银行不卖 |",
        "| 4 | 📝 必填原因 | 后端强制要求 |",
    ]
    if l1:
        # 找 L1 第一种资源做例子
        first_res = next(((k, int(l1[k])) for k in RES_KEYS
                          if l1.get(k) and int(l1[k]) > 0), None)
        if first_res:
            k, need_units = first_res
            res_full = RES_LABEL[k]                  # "💧 水"
            res_zh = res_full.split(" ")[1]          # "水"
            bks = max(1, need_units // unit)
            total = bks * my_price
            blocks += [
                "",
                f"#### 🎯 例子: {meta['flag']} 买 {need_units} 单位 {res_full} (为做 1 个 **{l1['name']}** 备料)",
                "",
                "| # | 操作 | 结果 |",
                "|---|---|---|",
                f"| 1 | 打开 🛒 银行采购 modal | 默认 tab = 「基础资源」 |",
                f"| 2 | 点 {res_full} 那一行 | 显示单价 **{my_price}**/{unit} 单位{jp_note} |",
                f"| 3 | 数量步进 → {bks} 块 | 总价 **{total} 金币** ({bks}×{my_price}) |",
                f"| 4 | 填原因 → 确认 | 金币 −{total} · {res_zh} +{need_units} 单位 |",
                "",
                "#### 📊 前后对比 (假设国家 Lv.2 · 金币 10,000)",
                "",
                "| 项目 | 前 | 后 |",
                "|---|---|---|",
                f"| 💰 金币 | 10,000 | {10000-total:,} |",
                f"| {res_full} | 0 | {need_units} |",
            ]
    blocks += ["", "---", ""]

    # ============================================================
    # 12.2 📋 申请采购单
    # ============================================================
    blocks += [
        "### 12.2 📋 申请采购单 (PO)",
        "",
        "#### 📋 条件",
        "",
        "| # | 条件 | 说明 |",
        "|---|---|---|",
        f"| 1 | 💰 足够金币 | 每张 **{purchase_cost} 金币** (Config.purchase_cost) |",
        f"| 2 | 📦 持单未满 | Lv.1→{po_limits[0]} · Lv.2→{po_limits[1]} · Lv.3→{po_limits[2]} · Lv.4→{po_limits[3]} 张 |",
        "| 3 | 🔑 申请级别 ≤ 国家等级 | Lv.1→L1 · Lv.2→L1/L2 · Lv.3→L1/L2/L3 · Lv.4→全开 (其他显示 🔒) |",
        "| 4 | 📝 本国有该 Level 产品 | Recipes 表里有该国 LX 行 |",
        "",
        "#### 🎲 抽奖机制",
        "",
        "| 候选 | 权重 |",
        "|---|---|",
        "| 你**已持有**的产品 | 1 |",
        "| 你**没持有**的产品 | 5 (`Config.purchase_dup_ratio`, 可改) |",
        "",
        "→ 想凑不同产品比重复抽快 5 倍, 但仍可能撞到同一个",
    ]
    if l1:
        blocks += [
            "",
            f"#### 🎯 例子: {meta['flag']} Lv.2 国家申请 L1 采购单",
            "",
            "| # | 操作 | 结果 |",
            "|---|---|---|",
            "| 1 | 打开 📋 采购中心 modal | 顶部状态: Lv.2 · 持单 1/3 · 金币 18,200 |",
            f"| 2 | 点 **L1** 大按钮 (L3/L4 显示 🔒) | 系统扣 {purchase_cost} 金币 |",
            f"| 3 | 系统按权重随机抽 | toast: 「采购单 L1: **{l1['name']}**」 |",
            "| 4 | 卡片刷新 | 持单 2/3 |",
            "",
            "#### 📊 前后对比",
            "",
            "| 项目 | 前 | 后 |",
            "|---|---|---|",
            f"| 💰 金币 | 18,200 | {18200-purchase_cost:,} |",
            "| 📋 持单数 | 1/3 | 2/3 |",
            f"| 📋 新采购单 | — | L1 · {l1['name']} |",
        ]
    blocks += ["", "---", ""]

    # ============================================================
    # 12.3 🏭 生产
    # ============================================================
    blocks += [
        "### 12.3 🏭 生产 + 丢骰",
        "",
        "#### 📋 条件",
        "",
        "| # | 条件 | 说明 |",
        "|---|---|---|",
        "| 1 | 📋 持有采购单 | 没单 → 制造列表看不到此产品 |",
        "| 2 | 💧 资源够 | 按 Recipe 各项,缺一不可 |",
        "| 3 | ⚙️ 半成品够 | L2+ 需要 semi1-4 库存全达标 |",
        "| 4 | 📝 必填原因 + 骰子结果 (1-6) | 后端强制 |",
        "",
        "#### 🎲 骰子机制",
        "",
        "| 骰点 | 结果 | 影响 |",
        "|---|---|---|",
        "| 🎲 **1** (17%) | 💥 失败 | 资源扣 · 采购单作废 · **不出产品** (计数器仍 +1) |",
        "| 🎲 **2-6** (83%) | ✅ 成功 | 资源扣 · 采购单作废 · 产品库存 **+1** · 计数器 +1 |",
    ]
    if l1:
        cost_table_rows = []
        for k in RES_KEYS:
            v = l1.get(k)
            if v and int(v) > 0:
                cost_table_rows.append(f"| {RES_LABEL[k]} | {int(v)} |")
        cost_table = "\n".join(cost_table_rows)
        blocks += [
            "",
            f"#### 🎯 例子: {meta['flag']} 制造 1 个 **{l1['name']}** (L1)",
            "",
            "**配方需要:**",
            "",
            "| 资源 | 数量 |",
            "|---|---|",
            cost_table,
            "",
            "**操作流程:**",
            "",
            "| # | 操作 | 结果 |",
            "|---|---|---|",
            f"| 1 | 已有 L1 采购单 (产品 = {l1['name']}) | ✓ |",
            "| 2 | 库存足够 (按上表) | ✓ 配方各项都满足 |",
            f"| 3 | 打开 🏭 modal → 点 {l1['name']} | 系统验证配方,无红色缺料标记 |",
            "| 4 | 玩家亲手丢实体骰 → 🎲 **3** | 导师按对应数字 |",
            "| 5 | 后端处理 | 资源扣 · 采购单作废 · 产品 +1 · `l1_orders` +1 |",
            "| 6 | 全屏动画 | ✅ **生产成功** |",
            "",
            "#### 📊 前后对比 (成功情况, 🎲≥2)",
            "",
            "| 项目 | 前 | 后 |",
            "|---|---|---|",
        ]
        for k in RES_KEYS:
            v = l1.get(k)
            if v and int(v) > 0:
                n = int(v)
                blocks.append(f"| {RES_LABEL[k]} | {n} | 0 |")
        blocks += [
            f"| 📋 采购单 ({l1['name']}) | active | consumed |",
            f"| 🏭 {l1['name']} 库存 | 0 | 1 |",
            "| `l1_orders` 计数器 | n | n+1 |",
            "",
            "> ⚠️ **失败分支 🎲1:** 资源照样扣 · 采购单照样作废 · **但不出产品**。`l1_orders` 仍 +1 (计数失败尝试)。想重做 → 重新申请采购单 + 重新攒资源。",
        ]
    blocks += ["", "---", ""]

    # ============================================================
    # 12.4 💸 销售
    # ============================================================
    blocks += [
        "### 12.4 💸 销售 + 丢运输骰",
        "",
        "#### 📋 条件",
        "",
        "| # | 条件 | 说明 |",
        "|---|---|---|",
        "| 1 | 📦 库存足够 | 产品数 ≥ 销售数量 |",
        "| 2 | 🎯 选定对象 | 🏦 银行 (固定 sell_price) **或** 🇲🇾/🇰🇷/🇯🇵/🇺🇸 (协商价) |",
        "| 3 | 🚫 不能卖给自己 | 后端拒 |",
        "| 4 | 🔒 L4 只能卖银行 | L4 跨国后端拒 + 前端 🔒 |",
        "| 5 | 📝 必填销售原因 | 后端强制 |",
        "| 6 | 🎲 输入运输骰 *或* 🎫 用免失败卡 | 二选一 |",
        "",
        "#### 🎲 运输骰机制",
        "",
        "| 骰点 | 结果 | 影响 |",
        "|---|---|---|",
        "| 🎲 **4** (17%) | 💥 运输失败 | 产品扣 · **金币不加** · `shipments` 不加 |",
        "| 🎲 **1/2/3/5/6** (83%) | ✅ 成功 | 产品扣 · 金币 +(qty × 单价) · `shipments` +1 |",
        "| 🎫 **免失败运输卡** | ✅ 自动成功 (100%) | 跳过骰子 · 卡 -1 (R&D 中奖品) |",
    ]
    if l1:
        p = price_for(l1["name"]) or {}
        sp = int(float(p.get("sell_price") or 0))
        qty = 3
        gross = sp * qty
        blocks += [
            "",
            f"#### 🎯 例子: {meta['flag']} 卖 {qty} 个 **{l1['name']}** 给 🏦 银行",
            "",
            "| # | 操作 | 结果 |",
            "|---|---|---|",
            f"| 1 | 库存有 5 个 {l1['name']} | ✓ |",
            f"| 2 | 打开 💸 销售 modal → 点 {l1['name']} | 显示 sell_price={sp:,} |",
            "| 3 | 销售对象 → 🏦 银行 | 单价自动锁定,不可改 |",
            f"| 4 | 数量 → {qty} | 总额 {gross:,} 金币 |",
            "| 5 | 玩家丢运输骰 → 🎲 **3** | 导师按 3 |",
            f"| 6 | 后端处理 | 产品 -{qty} · 金币 +{gross:,} · `shipments` +1 |",
            "",
            "#### 📊 前后对比 (成功情况, 🎲≠4)",
            "",
            "| 项目 | 前 | 后 |",
            "|---|---|---|",
            f"| 🏭 {l1['name']} 库存 | 5 | {5-qty} |",
            f"| 💰 金币 | X | X + {gross:,} |",
            "| 🚚 `shipments` | n | n+1 |",
            "",
            "> ⚠️ **失败分支 🎲4:** 产品 -3 (照扣) · **金币不加** · `shipments` 不加。",
            "",
            f"> 💡 **🎫 免失败卡何时用:** 大单 (≥5 个) 或 L3/L4 单价高的关键运输 — 失败一次损失 {sp*5:,}+ 金币,而卡只有几张。小单 (×1-2) 直接丢骰即可,期望损失小于卡的稀缺成本。",
        ]
    blocks += ["", "---", ""]

    # ============================================================
    # 12.5 🎁 研发
    # ============================================================
    total_w = sum(float(r.get("weight") or 0) for r in DATA["rd_prizes"])
    blocks += [
        "### 12.5 🎁 研发 (R&D)",
        "",
        "#### 📋 条件",
        "",
        "| # | 条件 | 说明 |",
        "|---|---|---|",
        f"| 1 | 💰 足够金币 | 每次 **{rd_cost} 金币** (Config.rd_cost) |",
        "| 2 | 📝 必填原因 | 默认填好「研发部投资」 |",
        "| 3 | 🎁 奖池非空 | RDPrizes 表至少一行 |",
        "",
        "#### 🎲 机制",
        "",
        "| 阶段 | 概率 | 结果 |",
        "|---|---|---|",
        f"| 立刻扣费 | 100% | 金币 -{rd_cost} (无论后续成功失败) |",
        f"| 💥 失败 | **{rd_fail*100:.0f}%** | 钱没了,啥也不拿 |",
        f"| ✅ 成功 | **{rd_succ*100:.0f}%** | 从奖池按权重抽一项 |",
        "",
        "#### 🎁 奖池 (live · sheet 实时)",
        "",
        "| 奖品 | 权重 | 条件成功后命中率 | 整体命中率 |",
        "|---|---|---|---|",
    ]
    for r in DATA["rd_prizes"]:
        w = float(r.get("weight") or 0)
        cond_pct = (w / total_w * 100) if total_w else 0
        overall_pct = cond_pct * rd_succ
        blocks.append(
            f"| {r.get('label', '?')} | {int(w)} | {cond_pct:.0f}% | **{overall_pct:.0f}%** |"
        )
    starting_coins = 10000
    blocks += [
        "",
        f"#### 🎯 例子: {meta['flag']} 国家投资一次研发",
        "",
        "| # | 操作 | 结果 |",
        "|---|---|---|",
        f"| 1 | 当前金币 {starting_coins:,} | ✓ ≥ {rd_cost} |",
        f"| 2 | 打开 🎁 研发 modal | 看奖池预览 + 失败率 {rd_fail*100:.0f}% |",
        f"| 3 | 确认投资 | 立刻扣 {rd_cost} → 余 **{starting_coins-rd_cost:,}** |",
        f"| 4 | 后端随机 | {rd_fail*100:.0f}% 失败 / {rd_succ*100:.0f}% 抽奖品 |",
        f"| 5a | (举例: 抽中「金币 +2,000」) | 金币 → **{starting_coins-rd_cost+2000:,}** ✅ |",
        f"| 5b | (举例: 失败) | 金币留 **{starting_coins-rd_cost:,}** 💥 |",
        "",
        "> 💡 **什么时候研发?** 金币 ≥ 5,000 + 急需某资源/免失败卡时再投。开局别乱研发 — 30% 失败率会把你打回起点。",
        "",
    ]

    return "\n".join(blocks)


def build_guide(cid):
    """Compose <country>'s guide markdown by extending GAME_GUIDE.md."""
    base = (ROOT / "GAME_GUIDE.md").read_text(encoding="utf-8")
    meta = COUNTRY_META[cid]
    # 改标题
    base = re.sub(
        r"^# 青年营计分台 · 国家玩家指南.*$",
        f"# 青年营计分台 · {meta['flag']} {meta['name']} 玩家指南",
        base, count=1, flags=re.MULTILINE,
    )
    # 在 §1 表格里高亮当前国家
    own_chip = "👑 你"
    def highlight_row(m):
        if cid.upper() in m.group(0):
            return m.group(0).rstrip("\n").rstrip("|") + f" {own_chip} |\n"
        return m.group(0)
    # In §1 country table — append a marker column. Use a softer approach:
    # just bold the row's country cell with a leading 👑.
    base = re.sub(
        rf"(\| {re.escape(meta['flag'])} \*\*{re.escape(meta['name'])} {cid.upper()}\*\* \|)",
        rf"| 👑 {meta['flag']} **{meta['name']} {cid.upper()}** |",
        base, count=1,
    )

    # Append country-specific sections before the final closing chapter.
    # New ordering: 9 起手速查 / 10 制造手册 / 11 销售估值 / 12 操作清单 / 13 终局
    extra = (
        "\n\n---\n\n"
        + strategy_overview_section(cid)
        + "\n---\n\n"
        + manufacturing_section(cid)
        + "\n---\n\n"
        + pricing_section(cid)
        + "\n---\n\n"
        + operations_section(cid)
        + "\n"
    )
    CLOSE_MARK = "<<<__CLOSING_CHAPTER__>>>"
    if "## 9. 🏁 终局" in base:
        base = base.replace("## 9. 🏁 终局", CLOSE_MARK)
        base = base.replace(CLOSE_MARK, extra + "\n## 13. 🏁 终局")
    else:
        base += extra
    return base


def main():
    print(f"Data updated_at: {DATA.get('updated_at')}")
    print()
    pairs = []
    for cid in ["my", "kr", "jp", "us"]:
        md = build_guide(cid)
        md_path = ROOT / f"GAME_GUIDE_{cid.upper()}.md"
        md_path.write_text(md, encoding="utf-8")
        print(f"  → {md_path.name} ({len(md)} chars)")
        pairs.append((md_path, ROOT / f"GAME_GUIDE_{cid.upper()}.pdf"))

    print()
    print("Rendering PDFs …")
    for md_path, pdf_path in pairs:
        md2pdf.convert(md_path, pdf_path)


if __name__ == "__main__":
    main()
