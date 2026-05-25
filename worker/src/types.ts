export interface Env {
  DB: D1Database;
}

export interface CountryRow {
  country_id: string;
  name: string;
  flag: string;
  domain: string;
  level: number;
  coins: number;
  asset: number;
  love: number;
  honor: number;
  water: number;
  oil: number;
  wood: number;
  metal: number;
  electricity: number;
  chips: number;
  l1_orders: number;
  l2_orders: number;
  l3_orders: number;
  l4_orders: number;
  shipments: number;
  no_fail_cards: number;
  last_draw_at: string | null;
}

export interface ProductRow {
  country_id: string;
  name: string;
  level: number;
  qty: number;
}

export interface PriceRow {
  item_type: string;
  item_key: string;
  unit_size: number;
  price: number;
  price_jp: number | null;
  sell_price: number;
  asset_value: number;
  note: string | null;
}

export interface RecipeRow {
  name: string;
  country: string;
  level: number;
  water: number;
  oil: number;
  wood: number;
  metal: number;
  electricity: number;
  chips: number;
  semi1: string | null;
  semi2: string | null;
  semi3: string | null;
  semi4: string | null;
  note: string | null;
}

export interface PurchaseOrderRow {
  id: string;
  country_id: string;
  level: number;
  product: string;
  status: string;
  created_at: string;
  consumed_at: string | null;
  mentor_apply: string | null;
  mentor_consume: string | null;
}

export interface RDPrize {
  id: number;
  type: string;
  value: number;
  weight: number;
  label: string | null;
  note: string | null;
}

export interface LogRow {
  id: number;
  timestamp: string;
  mentor: string | null;
  country_id: string | null;
  event: string | null;
  field: string | null;
  delta: number | null;
  before: number | null;
  after: number | null;
  detail: string | null;
  reason: string | null;
}

export type Json = Record<string, unknown> | unknown[];

export const RES_KEYS = ['water', 'oil', 'wood', 'metal', 'electricity', 'chips'] as const;
export type ResKey = typeof RES_KEYS[number];

export const RES_LABELS: Record<string, string> = {
  water: '水', oil: '石油', wood: '木材',
  metal: '金属', electricity: '电力', chips: '晶片',
};

export const ALLOWED_ADJUST_FIELDS = new Set([
  'coins', 'love', 'honor', 'asset',
  'water', 'oil', 'wood', 'metal', 'electricity', 'chips',
  'l1_orders', 'l2_orders', 'l3_orders', 'l4_orders', 'shipments',
  'level', 'no_fail_cards',
]);
