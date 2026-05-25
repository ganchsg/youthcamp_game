import type { Env } from './types';
import { err, json, resolveCountryToken, resolveMentorToken } from './util';
import { dumpData } from './actions/dump';
import { adjust } from './actions/adjust';
import { produce } from './actions/produce';
import { purchaseApply } from './actions/purchase';
import { rd } from './actions/rd';
import { buy } from './actions/buy';
import { sell } from './actions/sell';
import { reset } from './actions/reset';
import { readLogs } from './actions/logs';

/**
 * Mirror of doGet/doPost in apps-script.gs.
 * Auth: every write requires ?mentor=<token>; readonly reads can pass ?country=<token>.
 * Both GET (querystring) and POST (JSON body) are accepted.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      const url = new URL(request.url);
      const params: Record<string, string> = Object.fromEntries(url.searchParams);

      // Merge POST JSON body into params (body overrides URL params)
      if (request.method === 'POST') {
        try {
          const body = await request.json() as Record<string, unknown>;
          for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null) params[k] = String(v);
          }
        } catch {
          // ignore — empty / non-JSON body falls back to URL params
        }
      }

      const action = params.action || '';
      const countryToken = params.country || '';
      const mentorTokenStr = params.mentor || '';

      // ===== Readonly (team) mode: ?country=<token> =====
      if (countryToken) {
        const country_id = await resolveCountryToken(env, countryToken);
        if (!country_id) return err('invalid country token');
        if (action === 'adjust' || action === 'produce' || action === 'purchase_apply' ||
            action === 'rd' || action === 'reset' || action === 'buy' || action === 'sell') {
          return err('只读模式不允许修改数据');
        }
        if (action === 'logs') {
          return readLogs(env, country_id, Number(params.limit) || 100);
        }
        return dumpData(env, country_id, null);
      }

      // ===== Mentor (editor) mode: ?mentor=<token> required =====
      if (!mentorTokenStr) {
        return json({ ok: false, error: 'missing token', missing_token: true });
      }
      const mentor_id = await resolveMentorToken(env, mentorTokenStr);
      if (!mentor_id) {
        return json({ ok: false, error: 'invalid mentor token', missing_token: true });
      }

      // Stamp resolved mentor letter into params so actions can read it.
      params.mentor = mentor_id;

      switch (action) {
        case 'adjust':         return adjust(env, params);
        case 'produce':        return produce(env, params);
        case 'purchase_apply': return purchaseApply(env, params);
        case 'rd':             return rd(env, params);
        case 'reset':          return reset(env, params);
        case 'buy':            return buy(env, params);
        case 'sell':           return sell(env, params);
        case 'logs':           return readLogs(env, params.country_id || null, Number(params.limit) || 100);
        case 'recipes': {
          // Frontend doesn't actually use this anymore (recipes come from dumpData),
          // but keep it for parity with the old GAS endpoint.
          const r = await env.DB.prepare('SELECT * FROM recipes').all();
          return json({ ok: true, recipes: r.results ?? [] });
        }
        case '':               return dumpData(env, null, mentor_id);
        default:               return err('unknown action: ' + action);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ ok: false, error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
