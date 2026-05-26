import type { Env, RecipeRow } from '../types';
import { err, ok, getCountry, getPriceInfo, getRecipes, addProduct, writeLog } from '../util';

export interface BuyBody {
  country_id?: string;
  item_type?: string;
  item_key?: string;
  qty?: string | number;
  reason?: string;
  mentor?: string;
}

const RES_COLS = new Set(['water', 'oil', 'wood', 'metal', 'electricity', 'chips']);

export async function buy(env: Env, b: BuyBody): Promise<Response> {
  const country_id = b.country_id;
  const item_type = b.item_type;
  const item_key = b.item_key;
  const qty = Number(b.qty);
  const mentor = (b.mentor ?? '').toString().trim();
  const reason = (b.reason ?? '').toString().trim();

  if (!country_id) return err('missing country_id');
  if (!item_type || !item_key) return err('missing item');
  if (!['resource', 'l1', 'l2', 'l3'].includes(item_type)) {
    return err('item_type 必须是 resource/l1/l2/l3');
  }
  if (!Number.isFinite(qty) || qty <= 0) return err('qty 必须为正数');
  if (!mentor) return err('必须先选择导师身份');
  if (!reason) return err('必须填写采购原因');

  const priceInfo = await getPriceInfo(env, item_type, item_key, country_id);
  if (!priceInfo) return err('未知商品 (prices 表中找不到): ' + item_key);

  // L1 only buyable from own country; L2/L3 from any country (via bank)
  if (item_type === 'l1' || item_type === 'l2' || item_type === 'l3') {
    const recipes = await getRecipes(env);
    const recipe: RecipeRow | undefined = recipes[item_key];
    if (!recipe) return err('未知产品: ' + item_key);
    if (item_type === 'l1' && recipe.country !== country_id) {
      return err(`${item_key} 不属于 ${country_id.toUpperCase()}，L1 只能购买本国产品`);
    }
  }

  if (item_type === 'resource' && !RES_COLS.has(item_key)) {
    return err('resource 名不合法: ' + item_key);
  }

  const totalUnits = qty * priceInfo.unit_size;
  const totalCost = qty * priceInfo.price;

  const country = await getCountry(env, country_id);
  if (!country) return err('country not found');

  // Level gate: Lv.1 → only resources; Lv.2 → +L1; Lv.3 → +L2; Lv.4 → +L3
  const countryLvl = Math.max(1, Math.min(4, Number(country.level) || 1));
  const CAT_MIN_LVL: Record<string, number> = { resource: 1, l1: 2, l2: 3, l3: 4 };
  const minLvl = CAT_MIN_LVL[item_type] ?? 1;
  if (countryLvl < minLvl) {
    const catLabel = ({ resource: '基础资源', l1: 'L1 产品', l2: 'L2 产品', l3: 'L3 产品' } as const)[item_type as 'resource'|'l1'|'l2'|'l3'] ?? item_type;
    return err(`国家当前 Lv.${countryLvl},无法采购 ${catLabel} (需先升到 Lv.${minLvl})`);
  }

  const curCoins = Number(country.coins) || 0;
  if (curCoins < totalCost) return err(`金币不足: 需 ${totalCost}, 当前 ${curCoins}`);

  // Deduct coins atomically
  const upd = await env.DB
    .prepare('UPDATE countries SET coins = coins - ? WHERE country_id = ? AND coins >= ?')
    .bind(totalCost, country_id, totalCost).run();
  if (!upd.meta || (upd.meta.changes ?? 0) === 0) {
    return err('金币不足或并发冲突，请重试');
  }
  const newCoins = curCoins - totalCost;
  const changes: string[] = [`coins: ${curCoins}→${newCoins}`];

  if (item_type === 'resource') {
    const before = Number((country as unknown as Record<string, unknown>)[item_key]) || 0;
    const after = before + totalUnits;
    await env.DB
      .prepare(`UPDATE countries SET "${item_key}" = ? WHERE country_id = ?`)
      .bind(after, country_id).run();
    changes.push(`${item_key}: ${before}→${after}`);
  } else {
    const lvl = ({ l1: 1, l2: 2, l3: 3 } as Record<string, number>)[item_type];
    const pc = await addProduct(env, country_id, lvl, item_key, qty);
    changes.push(`${item_key}: ${pc.before}→${pc.after}`);
  }

  const tag = item_type === 'resource' ? '基础资源' : ({ l1: 'L1 产品', l2: 'L2 产品', l3: 'L3 产品' } as Record<string, string>)[item_type];
  const qtyStr = item_type === 'resource' ? `${totalUnits}单位` : `×${qty}`;
  // Dedicated coin log row first (so `WHERE field='coins'` catches every coin movement)
  await writeLog(env, mentor, country_id, 'buy', 'coins', -totalCost, curCoins, newCoins,
                 `💰 采购 [${tag}] ${item_key} ${qtyStr} -${totalCost} 金币`, reason);
  const detail = `🛒 采购 [${tag}] ${item_key} ${qtyStr} (单价 ${priceInfo.price}, 共 ${totalCost} 金币) | ${changes.join(', ')}`;
  await writeLog(env, mentor, country_id, 'buy', item_key, -totalCost, curCoins, newCoins, detail, reason);

  return ok({
    item_key,
    qty,
    total_units: totalUnits,
    total_cost: totalCost,
    new_coins: newCoins,
  });
}
