import type { Env, RecipeRow } from '../types';
import {
  err, ok, getCountry, addProduct, writeLog, getRecipes,
  recipeResources, recipeSemis, nowIso,
} from '../util';

export interface ProduceBody {
  country_id?: string;
  product?: string;
  dice?: string | number;
  reason?: string;
  mentor?: string;
}

export async function produce(env: Env, b: ProduceBody): Promise<Response> {
  const country_id = b.country_id;
  const productName = b.product;
  const dice = b.dice !== '' && b.dice != null ? Number(b.dice) : NaN;
  const reason = (b.reason ?? '').toString().trim();
  const mentor = (b.mentor ?? '').toString().trim();

  if (!country_id) return err('missing country_id');
  if (!productName) return err('missing product');
  if (!reason) return err('必须填写生产原因');
  if (!mentor) return err('必须先选择导师身份 (A/B/C/D/E)');
  if (!Number.isFinite(dice) || dice < 1 || dice > 6) {
    return err('必须输入骰子结果 (1-6)');
  }

  const recipes = await getRecipes(env);
  const recipe: RecipeRow | undefined = recipes[productName];
  if (!recipe) return err('未知产品: ' + productName);

  const success = dice !== 1;

  // ----- Require active PO (FIFO by created_at) -----
  const po = await env.DB
    .prepare(`SELECT id, level FROM purchase_orders
              WHERE country_id = ? AND product = ? AND status = 'active'
              ORDER BY created_at ASC LIMIT 1`)
    .bind(country_id, productName)
    .first<{ id: string; level: number }>();
  if (!po) return err(`没有「${productName}」的采购单 — 请先到采购中心申请`);

  const country = await getCountry(env, country_id);
  if (!country) return err('country not found: ' + country_id);

  const resReq = recipeResources(recipe);
  const semiReq = recipeSemis(recipe);

  // Check resources
  for (const [k, need] of Object.entries(resReq)) {
    const have = Number((country as unknown as Record<string, unknown>)[k]) || 0;
    if (have < need) return err(`资源不足: ${k} ${have} < ${need}`);
  }

  // Check semi-products
  const semiMap = new Map<string, number>();
  if (semiReq.length) {
    const placeholders = semiReq.map(() => '?').join(',');
    const rows = await env.DB
      .prepare(`SELECT name, qty FROM products WHERE country_id = ? AND name IN (${placeholders})`)
      .bind(country_id, ...semiReq).all<{ name: string; qty: number }>();
    for (const row of rows.results ?? []) semiMap.set(row.name, Number(row.qty) || 0);
    for (const semiName of semiReq) {
      const have = semiMap.get(semiName) ?? 0;
      if (have < 1) return err(`半成品不足: ${semiName} (库存 ${have})`);
    }
  }

  // ----- APPLY (collect changes for log) -----
  const changes: string[] = [];

  // 1) Deduct resources
  const resPairs = Object.entries(resReq);
  for (const [k, need] of resPairs) {
    const before = Number((country as unknown as Record<string, unknown>)[k]) || 0;
    const after = before - need;
    await env.DB
      .prepare(`UPDATE countries SET "${k}" = ? WHERE country_id = ?`)
      .bind(after, country_id).run();
    changes.push(`${k}: ${before}→${after}`);
  }

  // 2) Deduct semi-products
  for (const semiName of semiReq) {
    const before = semiMap.get(semiName) ?? 0;
    const after = before - 1;
    await env.DB
      .prepare('UPDATE products SET qty = ? WHERE country_id = ? AND name = ?')
      .bind(after, country_id, semiName).run();
    changes.push(`${semiName}: ${before}→${after}`);
  }

  // 3) Consume PO
  await env.DB
    .prepare(`UPDATE purchase_orders SET status='consumed', consumed_at=?, mentor_consume=? WHERE id=?`)
    .bind(nowIso(), mentor, po.id).run();

  // 4) Bump l{N}_orders
  const lField = `l${recipe.level}_orders`;
  if (['l1_orders', 'l2_orders', 'l3_orders', 'l4_orders'].includes(lField)) {
    const before = Number((country as unknown as Record<string, unknown>)[lField]) || 0;
    const after = before + 1;
    await env.DB
      .prepare(`UPDATE countries SET "${lField}" = ? WHERE country_id = ?`)
      .bind(after, country_id).run();
    changes.push(`${lField}: ${before}→${after}`);
  }

  // 5) On success: add product
  let productBefore = 0, productAfter = 0;
  if (success) {
    const pc = await addProduct(env, country_id, recipe.level, productName, 1);
    productBefore = pc.before;
    productAfter = pc.after;
    changes.push(`${productName}: ${productBefore}→${productAfter}`);
  }

  // 6) Log
  const event = success ? 'produce_ok' : 'produce_fail';
  const tag = success ? '✓制造' : '✗失败';
  const detail = `${tag} ${productName} [Lv.${recipe.level}] | 🎲${dice} | 采购单#${po.id}消耗 | ${changes.join(', ')}`;
  await writeLog(env, mentor, country_id, event, productName, success ? 1 : 0,
                 productBefore, productAfter, detail, reason);

  return ok({
    success,
    dice,
    product: productName,
    level: recipe.level,
    po_id: po.id,
    consumed: { res: resReq, semi: semiReq },
  });
}
