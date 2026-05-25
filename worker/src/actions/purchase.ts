import type { Env } from '../types';
import { err, ok, getCountry, getConfigNum, getRecipes, writeLog, genPOId, nowIso } from '../util';

export interface PurchaseApplyBody {
  country_id?: string;
  level?: string | number;
  reason?: string;
  mentor?: string;
}

export async function purchaseApply(env: Env, b: PurchaseApplyBody): Promise<Response> {
  const country_id = b.country_id;
  const level = Number(b.level);
  const mentor = (b.mentor ?? '').toString().trim();
  const reason = (b.reason ?? '申请采购单').toString().trim();

  if (!country_id) return err('missing country_id');
  if (!Number.isFinite(level) || level < 1 || level > 4) return err('level 必须是 1-4');
  if (!mentor) return err('必须先选择导师身份');

  const cost = await getConfigNum(env, 'purchase_cost', 100);

  const country = await getCountry(env, country_id);
  if (!country) return err('country not found');

  const countryLevel = Math.max(1, Math.min(4, Number(country.level) || 1));
  const LIMIT_DEFAULTS: Record<number, number> = { 1: 2, 2: 3, 3: 5, 4: 5 };
  const limit = await getConfigNum(env, 'purchase_limit_l' + countryLevel, LIMIT_DEFAULTS[countryLevel]);

  if (level > countryLevel) {
    return err(`国家当前 Lv.${countryLevel},无法申请 L${level} 采购单 (需先升到 Lv.${level})`);
  }

  // Existing active POs for this country
  const activeRes = await env.DB
    .prepare(`SELECT product FROM purchase_orders WHERE country_id = ? AND status = 'active'`)
    .bind(country_id).all<{ product: string }>();
  const active = activeRes.results ?? [];
  if (active.length >= limit) {
    return err(`已持有 ${active.length} 张采购单，达到上限 ${limit} 张 (国家 Lv.${countryLevel})`);
  }

  // Pool: country + level
  const recipes = await getRecipes(env);
  const pool = Object.values(recipes)
    .filter(r => r.country === country_id && r.level === level)
    .map(r => r.name);
  if (pool.length === 0) {
    return err(`${country_id.toUpperCase()} 在 L${level} 没有可用产品`);
  }

  // Weighted random (non-held → weight=dupRatio, held → weight=1)
  const activeProducts = new Set(active.map(a => String(a.product)));
  const dupRatio = Math.max(1, await getConfigNum(env, 'purchase_dup_ratio', 5));
  const weights = pool.map(name => activeProducts.has(name) ? 1 : dupRatio);

  const curCoins = Number(country.coins) || 0;
  if (curCoins < cost) return err(`金币不足: 需 ${cost}, 当前 ${curCoins}`);

  // Deduct coins atomically (guard against negative balance via WHERE)
  const upd = await env.DB
    .prepare('UPDATE countries SET coins = coins - ? WHERE country_id = ? AND coins >= ?')
    .bind(cost, country_id, cost).run();
  if (!upd.meta || (upd.meta.changes ?? 0) === 0) {
    return err(`金币不足或并发冲突，请重试`);
  }
  const newCoins = curCoins - cost;

  // Weighted pick
  const totalW = weights.reduce((s, w) => s + w, 0);
  let rnd = Math.random() * totalW;
  let pickedIdx = 0;
  for (let i = 0; i < weights.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) { pickedIdx = i; break; }
  }
  const product = pool[pickedIdx];

  // Create PO
  const poId = genPOId();
  await env.DB
    .prepare(`INSERT INTO purchase_orders
              (id, country_id, level, product, status, created_at, mentor_apply)
              VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .bind(poId, country_id, level, product, nowIso(), mentor).run();

  const detail = `📋 申请采购单 L${level}: ${product} (花费 ${cost} 金币) #${poId} | 持单 ${active.length + 1}/${limit}`;
  await writeLog(env, mentor, country_id, 'purchase_apply', product, -cost, curCoins, newCoins, detail, reason);

  return ok({
    po: { id: poId, level, product, country_id, status: 'active' },
    cost,
    new_coins: newCoins,
    active_count: active.length + 1,
    limit,
    country_level: countryLevel,
    pool,
    pool_held: pool.filter(n => activeProducts.has(n)),
    dup_ratio: dupRatio,
  });
}
