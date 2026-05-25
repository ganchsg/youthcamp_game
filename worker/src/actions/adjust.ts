import type { Env } from '../types';
import { ALLOWED_ADJUST_FIELDS } from '../types';
import { err, ok, getCountry, writeLog } from '../util';

export interface AdjustBody {
  country_id?: string;
  field?: string;
  delta?: string | number;
  reason?: string;
  mentor?: string; // resolved mentor letter (A/B/...), set by router
}

export async function adjust(env: Env, b: AdjustBody): Promise<Response> {
  const country_id = b.country_id;
  const field = b.field;
  const delta = Number(b.delta);
  const reason = (b.reason ?? '').toString().trim();
  const mentor = (b.mentor ?? '').toString().trim();

  if (!country_id || !field) return err('missing country_id or field');
  if (!ALLOWED_ADJUST_FIELDS.has(field)) return err('field not allowed: ' + field);
  if (!Number.isFinite(delta)) return err('delta must be a number');
  if (!reason) return err('必须填写调整原因');
  if (!mentor) return err('必须先选择导师身份 (A/B/C/D/E)');

  const row = await getCountry(env, country_id);
  if (!row) return err('country not found: ' + country_id);

  const current = Number((row as unknown as Record<string, unknown>)[field]) || 0;
  const newVal = current + delta;

  // Lv. upper bound
  if (field === 'level' && newVal > 4) {
    return err(`Lv.${newVal} 超过最高等级 Lv.4 — 没有 Lv.5,不能再升`);
  }
  if (field === 'level' && newVal < 1) {
    return err(`Lv.${newVal} 无效 — 等级范围 1-4`);
  }

  // Field name is whitelisted by ALLOWED_ADJUST_FIELDS — safe to interpolate.
  await env.DB
    .prepare(`UPDATE countries SET "${field}" = ? WHERE country_id = ?`)
    .bind(newVal, country_id).run();

  await writeLog(
    env, mentor, country_id, 'adjust', field, delta, current, newVal,
    `${field} ${current} → ${newVal} (${delta > 0 ? '+' : ''}${delta})`, reason,
  );

  return ok({ country_id, field, old: current, new: newVal });
}
