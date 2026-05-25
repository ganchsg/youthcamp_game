import type { Env, RDPrize } from '../types';
import { RES_KEYS, RES_LABELS } from '../types';
import { err, ok, getCountry, getConfigNum, writeLog, weightedPick } from '../util';

export interface RDBody {
  country_id?: string;
  reason?: string;
  mentor?: string;
}

export async function rd(env: Env, b: RDBody): Promise<Response> {
  const country_id = b.country_id;
  const mentor = (b.mentor ?? '').toString().trim();
  const reason = (b.reason ?? '研发部投资').toString().trim();

  if (!country_id) return err('missing country_id');
  if (!mentor) return err('必须先选择导师身份');

  const cost = await getConfigNum(env, 'rd_cost', 500);
  const failRateRaw = await getConfigNum(env, 'rd_fail_rate', 0.2);
  const failRate = Math.max(0, Math.min(1, failRateRaw));

  const country = await getCountry(env, country_id);
  if (!country) return err('country not found');

  const curCoins = Number(country.coins) || 0;
  if (curCoins < cost) return err(`金币不足: 需 ${cost}, 当前 ${curCoins}`);

  // Deduct cost FIRST (always — fail or pass)
  const upd = await env.DB
    .prepare('UPDATE countries SET coins = coins - ? WHERE country_id = ? AND coins >= ?')
    .bind(cost, country_id, cost).run();
  if (!upd.meta || (upd.meta.changes ?? 0) === 0) {
    return err('金币不足或并发冲突，请重试');
  }
  const afterCost = curCoins - cost;

  // Roll fail
  if (Math.random() < failRate) {
    const detail = `🧪 研发失败 (花费 ${cost} 金币) | coins: ${curCoins}→${afterCost}`;
    await writeLog(env, mentor, country_id, 'rd_fail', 'coins', -cost, curCoins, afterCost, detail, reason);
    return ok({ success: false, cost, new_coins: afterCost });
  }

  // Pick prize
  const pool = await env.DB.prepare('SELECT * FROM rd_prizes').all<RDPrize>();
  const prizes = pool.results ?? [];
  if (!prizes.length) return err('RDPrizes 表为空，无奖品可领');
  const prize = weightedPick(prizes);
  if (!prize) return err('抽奖失败 — 奖品池权重无效');

  // Resolve prize → field + value
  let field: string, value: number, prizeLabel: string;
  if (prize.type === 'coins') {
    field = 'coins';
    value = Number(prize.value) || 0;
    prizeLabel = prize.label || `金币 +${value}`;
  } else if (prize.type === 'nofail') {
    field = 'no_fail_cards';
    value = Number(prize.value) || 0;
    prizeLabel = prize.label || `免失败运输卡 ×${value}`;
  } else if (prize.type === 'res') {
    field = RES_KEYS[Math.floor(Math.random() * RES_KEYS.length)];
    value = Number(prize.value) || 0;
    prizeLabel = prize.label
      ? `${prize.label} → ${RES_LABELS[field]} +${value}`
      : `${RES_LABELS[field]} +${value}`;
  } else {
    return err('未知奖品类型: ' + prize.type);
  }

  // Re-fetch the country (coins changed; the prize field may be the same row)
  const country2 = await getCountry(env, country_id);
  if (!country2) return err('country not found after coin deduction');
  const before = Number((country2 as unknown as Record<string, unknown>)[field]) || 0;
  const after = before + value;
  await env.DB
    .prepare(`UPDATE countries SET "${field}" = ? WHERE country_id = ?`)
    .bind(after, country_id).run();

  // The new coins value depends on whether the prize WAS coins
  const newCoins = field === 'coins' ? after : afterCost;

  const detail = `🧪 研发成功 (花费 ${cost} 金币) → ${prizeLabel} | coins: ${curCoins}→${afterCost}, ${field}: ${before}→${after}`;
  await writeLog(env, mentor, country_id, 'rd_ok', field, value, before, after, detail, reason);

  return ok({
    success: true,
    cost,
    new_coins: newCoins,
    prize: {
      type: prize.type, field, value, label: prizeLabel,
      before, after,
    },
  });
}
