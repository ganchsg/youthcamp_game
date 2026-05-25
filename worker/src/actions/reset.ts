import type { Env } from '../types';
import { err, ok, writeLog } from '../util';

export interface ResetBody {
  mentor?: string;
  confirm?: string;
}

export async function reset(env: Env, b: ResetBody): Promise<Response> {
  const mentor = (b.mentor ?? '').toString().trim();
  const confirm = (b.confirm ?? '').toString().trim();
  if (!mentor) return err('必须先选择导师身份');
  if (confirm !== 'RESET') return err('confirm 必须传 "RESET"（防止误触）');

  // 1) Wipe log / products / purchase_orders
  await env.DB.prepare('DELETE FROM log').run();
  await env.DB.prepare('DELETE FROM products').run();
  await env.DB.prepare('DELETE FROM purchase_orders').run();

  // 2) Reset countries to initial_state
  const initRows = await env.DB.prepare('SELECT * FROM initial_state').all<{
    country_id: string;
    coins: number;
    water: number; oil: number; wood: number;
    metal: number; electricity: number; chips: number;
  }>();
  const initMap = new Map<string, { coins: number } & Record<string, number>>();
  for (const r of initRows.results ?? []) {
    initMap.set(r.country_id, {
      coins: Number(r.coins) || 0,
      water: Number(r.water) || 0,
      oil: Number(r.oil) || 0,
      wood: Number(r.wood) || 0,
      metal: Number(r.metal) || 0,
      electricity: Number(r.electricity) || 0,
      chips: Number(r.chips) || 0,
    });
  }

  const countries = await env.DB.prepare('SELECT country_id FROM countries').all<{ country_id: string }>();
  const touched: string[] = [];
  for (const c of countries.results ?? []) {
    const cid = c.country_id;
    const init = initMap.get(cid) ?? {
      coins: 0, water: 0, oil: 0, wood: 0, metal: 0, electricity: 0, chips: 0,
    };
    await env.DB
      .prepare(`UPDATE countries SET
                  coins = ?, water = ?, oil = ?, wood = ?, metal = ?, electricity = ?, chips = ?,
                  love = 0, honor = 0, asset = 0,
                  l1_orders = 0, l2_orders = 0, l3_orders = 0, l4_orders = 0,
                  shipments = 0, no_fail_cards = 0,
                  level = 1, last_draw_at = NULL
                WHERE country_id = ?`)
      .bind(
        init.coins, init.water, init.oil, init.wood,
        init.metal, init.electricity, init.chips, cid,
      ).run();
    touched.push(cid);
  }

  // 3) Log the reset itself
  await writeLog(
    env, mentor, '', 'reset', '', 0, null, null,
    `🔄 RESET 重置游戏 · 影响国家: ${touched.join(', ')} · 清: log/products/purchase_orders, 恢复初始 coins+resources, 归零 love/honor/level/counters/cards`,
    '管理员重置',
  );

  return ok({ reset_countries: touched, at: new Date().toISOString() });
}
