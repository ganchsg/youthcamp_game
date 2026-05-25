import type { Env, RecipeRow, PriceRow } from './types';

// ----- JSON response with CORS -----
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  });
}

export function ok(extra: Record<string, unknown> = {}): Response {
  return json({ ok: true, ...extra });
}

export function err(message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra });
}

// ----- Tokens -----
export async function resolveMentorToken(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB
    .prepare('SELECT mentor_id FROM mentor_tokens WHERE token = ?')
    .bind(token).first<{ mentor_id: string }>();
  return row ? String(row.mentor_id) : null;
}

export async function resolveCountryToken(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB
    .prepare('SELECT country_id FROM country_tokens WHERE token = ?')
    .bind(token).first<{ country_id: string }>();
  return row ? String(row.country_id) : null;
}

// ----- Config (live-read each call) -----
export async function readConfig(env: Env): Promise<Record<string, string>> {
  const rows = await env.DB
    .prepare('SELECT key, value FROM config').all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results ?? []) out[r.key] = String(r.value);
  return out;
}

export async function getConfigNum(env: Env, key: string, fallback: number): Promise<number> {
  const cfg = await readConfig(env);
  const v = Number(cfg[key]);
  return Number.isFinite(v) ? v : fallback;
}

// ----- Recipes -----
export async function getRecipes(env: Env): Promise<Record<string, RecipeRow>> {
  const rows = await env.DB.prepare('SELECT * FROM recipes').all<RecipeRow>();
  const out: Record<string, RecipeRow> = {};
  for (const r of rows.results ?? []) out[r.name] = r;
  return out;
}

export function recipeResources(r: RecipeRow): Record<string, number> {
  const out: Record<string, number> = {};
  if (r.water) out.water = r.water;
  if (r.oil) out.oil = r.oil;
  if (r.wood) out.wood = r.wood;
  if (r.metal) out.metal = r.metal;
  if (r.electricity) out.electricity = r.electricity;
  if (r.chips) out.chips = r.chips;
  return out;
}

export function recipeSemis(r: RecipeRow): string[] {
  return [r.semi1, r.semi2, r.semi3, r.semi4]
    .filter((s): s is string => !!s && s.trim() !== '');
}

// ----- Prices -----
/** JP buying a resource → use price_jp if set. Otherwise plain price. */
export async function getPriceInfo(
  env: Env, item_type: string, item_key: string, country_id?: string
): Promise<{ unit_size: number; price: number; sell_price: number } | null> {
  const row = await env.DB
    .prepare('SELECT unit_size, price, price_jp, sell_price FROM prices WHERE item_type = ? AND item_key = ?')
    .bind(item_type, item_key)
    .first<{ unit_size: number; price: number; price_jp: number | null; sell_price: number }>();
  if (!row) return null;
  let buy = Number(row.price) || 0;
  if (country_id === 'jp' && row.price_jp != null) {
    const jp = Number(row.price_jp);
    if (Number.isFinite(jp) && jp > 0) buy = jp;
  }
  return {
    unit_size: Number(row.unit_size) || 1,
    price: buy,
    sell_price: Number(row.sell_price) || 0,
  };
}

// ----- Log -----
export async function writeLog(
  env: Env,
  mentor: string | null,
  country_id: string | null,
  event: string,
  field: string | null,
  delta: number | null,
  before: number | null,
  after: number | null,
  detail: string,
  reason: string,
): Promise<void> {
  await env.DB
    .prepare(`INSERT INTO log (timestamp, mentor, country_id, event, field, delta, "before", "after", detail, reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      new Date().toISOString(),
      mentor ?? '',
      country_id ?? '',
      event,
      field ?? '',
      delta,
      before,
      after,
      detail,
      reason,
    )
    .run();
}

// ----- Helpers shared by produce/buy -----
/** Increment the qty of (country_id, name) in products. Insert row if missing. */
export async function addProduct(
  env: Env, country_id: string, level: number, name: string, addQty = 1,
): Promise<{ before: number; after: number }> {
  const existing = await env.DB
    .prepare('SELECT qty FROM products WHERE country_id = ? AND name = ?')
    .bind(country_id, name).first<{ qty: number }>();
  if (existing) {
    const before = Number(existing.qty) || 0;
    const after = before + addQty;
    await env.DB
      .prepare('UPDATE products SET qty = ?, level = ? WHERE country_id = ? AND name = ?')
      .bind(after, level, country_id, name).run();
    return { before, after };
  }
  await env.DB
    .prepare('INSERT INTO products (country_id, name, level, qty) VALUES (?, ?, ?, ?)')
    .bind(country_id, name, level, addQty).run();
  return { before: 0, after: addQty };
}

export async function getCountry(env: Env, country_id: string): Promise<import('./types').CountryRow | null> {
  return env.DB
    .prepare('SELECT * FROM countries WHERE country_id = ?')
    .bind(country_id).first<import('./types').CountryRow>();
}

// ----- Misc -----
export function nowIso(): string {
  return new Date().toISOString();
}

export function genPOId(): string {
  return 'PO-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
}

export function weightedPick<T extends { weight: number }>(pool: T[]): T | null {
  const total = pool.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const p of pool) {
    r -= Number(p.weight) || 0;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}
