import type { Env, LogRow } from '../types';
import { json } from '../util';

export async function readLogs(
  env: Env, country_id: string | null, limit: number,
): Promise<Response> {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 100));
  const stmt = country_id
    ? env.DB.prepare(`SELECT timestamp, mentor, country_id, event, field, delta, "before", "after", detail, reason
                      FROM log WHERE country_id = ? ORDER BY timestamp DESC LIMIT ?`)
        .bind(country_id, safeLimit)
    : env.DB.prepare(`SELECT timestamp, mentor, country_id, event, field, delta, "before", "after", detail, reason
                      FROM log ORDER BY timestamp DESC LIMIT ?`)
        .bind(safeLimit);
  const res = await stmt.all<Omit<LogRow, 'id'>>();
  return json({ ok: true, logs: res.results ?? [] });
}
