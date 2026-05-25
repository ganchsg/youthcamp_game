import type { Env } from '../types';
import { json } from '../util';

/** Mirror of dumpData_ — returns all sheet contents in one payload. */
export async function dumpData(
  env: Env,
  country_id: string | null,
  mentor_id: string | null,
): Promise<Response> {
  // Run all reads in parallel (D1 supports concurrent prepared statements).
  const [
    countries, products, prices, config, rd_prizes,
    love_table, level_up, recipes, purchase_orders,
  ] = await Promise.all([
    country_id
      ? env.DB.prepare('SELECT * FROM countries WHERE country_id = ?').bind(country_id).all()
      : env.DB.prepare('SELECT * FROM countries').all(),
    country_id
      ? env.DB.prepare('SELECT * FROM products WHERE country_id = ?').bind(country_id).all()
      : env.DB.prepare('SELECT * FROM products').all(),
    env.DB.prepare('SELECT * FROM prices').all(),
    env.DB.prepare('SELECT * FROM config').all(),
    env.DB.prepare('SELECT * FROM rd_prizes').all(),
    env.DB.prepare('SELECT * FROM love_table').all(),
    env.DB.prepare('SELECT * FROM levelup').all(),
    env.DB.prepare('SELECT * FROM recipes').all(),
    country_id
      ? env.DB.prepare("SELECT * FROM purchase_orders WHERE country_id = ? AND status = 'active'").bind(country_id).all()
      : env.DB.prepare("SELECT * FROM purchase_orders WHERE status = 'active'").all(),
  ]);

  return json({
    ok: true,
    countries: countries.results ?? [],
    products: products.results ?? [],
    prices: prices.results ?? [],
    config: config.results ?? [],
    rd_prizes: rd_prizes.results ?? [],
    love_table: love_table.results ?? [],
    level_up: level_up.results ?? [],
    recipes: recipes.results ?? [],
    purchase_orders: purchase_orders.results ?? [],
    readonly: !!country_id,
    country_id: country_id || null,
    mentor_identity: mentor_id || null,
    updated_at: new Date().toISOString(),
  });
}
