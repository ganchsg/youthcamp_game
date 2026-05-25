-- ============================================================================
-- Youth Camp — D1 schema (mirror of the 13 sheets in apps-script.gs)
-- Apply:  wrangler d1 execute youthcamp --remote --file=./schema.sql
-- ============================================================================

-- Drop in reverse-FK order so re-runs are idempotent during development.
DROP TABLE IF EXISTS log;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS country_tokens;
DROP TABLE IF EXISTS mentor_tokens;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS prices;
DROP TABLE IF EXISTS initial_state;
DROP TABLE IF EXISTS love_table;
DROP TABLE IF EXISTS levelup;
DROP TABLE IF EXISTS rd_prizes;
DROP TABLE IF EXISTS config;
DROP TABLE IF EXISTS countries;

-- ============================================================================
-- countries — one row per country, the main mutable game state
-- ============================================================================
CREATE TABLE countries (
  country_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  flag           TEXT NOT NULL DEFAULT '',
  domain         TEXT NOT NULL DEFAULT '',
  level          INTEGER NOT NULL DEFAULT 1,
  coins          INTEGER NOT NULL DEFAULT 0,
  asset          INTEGER NOT NULL DEFAULT 0,
  love           INTEGER NOT NULL DEFAULT 0,
  honor          INTEGER NOT NULL DEFAULT 0,
  water          INTEGER NOT NULL DEFAULT 0,
  oil            INTEGER NOT NULL DEFAULT 0,
  wood           INTEGER NOT NULL DEFAULT 0,
  metal          INTEGER NOT NULL DEFAULT 0,
  electricity    INTEGER NOT NULL DEFAULT 0,
  chips          INTEGER NOT NULL DEFAULT 0,
  l1_orders      INTEGER NOT NULL DEFAULT 0,
  l2_orders      INTEGER NOT NULL DEFAULT 0,
  l3_orders      INTEGER NOT NULL DEFAULT 0,
  l4_orders      INTEGER NOT NULL DEFAULT 0,
  shipments      INTEGER NOT NULL DEFAULT 0,
  no_fail_cards  INTEGER NOT NULL DEFAULT 0,
  last_draw_at   TEXT
);

-- ============================================================================
-- products — per-country inventory of made/bought products
-- ============================================================================
CREATE TABLE products (
  country_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  level          INTEGER NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (country_id, name)
);

CREATE INDEX idx_products_country ON products(country_id);

-- ============================================================================
-- log — append-only audit trail
-- ============================================================================
CREATE TABLE log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,         -- ISO8601
  mentor      TEXT,
  country_id  TEXT,
  event       TEXT,
  field       TEXT,
  delta       REAL,
  "before"    REAL,
  "after"     REAL,
  detail      TEXT,
  reason      TEXT
);

CREATE INDEX idx_log_country_ts ON log(country_id, timestamp DESC);
CREATE INDEX idx_log_ts          ON log(timestamp DESC);

-- ============================================================================
-- country_tokens — readonly team-view tokens
-- mentor_tokens  — write-access mentor tokens (A/B/C/D/E)
-- ============================================================================
CREATE TABLE country_tokens (
  country_id  TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  note        TEXT
);

CREATE TABLE mentor_tokens (
  mentor_id   TEXT PRIMARY KEY,      -- 'A' / 'B' / 'C' / 'D' / 'E'
  token       TEXT NOT NULL UNIQUE,
  note        TEXT
);

-- ============================================================================
-- prices — buy/sell prices for resources + L1..L4 products
-- (jp_price overrides resource buy for JP only; sell_price + asset_value are
-- per-row, no country override.)
-- ============================================================================
CREATE TABLE prices (
  item_type    TEXT NOT NULL,        -- 'resource' | 'l1' | 'l2' | 'l3' | 'l4'
  item_key     TEXT NOT NULL,        -- 'water'/'oil'/... or product name
  unit_size    INTEGER NOT NULL DEFAULT 1,
  price        INTEGER NOT NULL DEFAULT 0,
  price_jp     INTEGER,              -- nullable; falls back to price
  sell_price   INTEGER NOT NULL DEFAULT 0,
  asset_value  INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  PRIMARY KEY (item_type, item_key)
);

-- ============================================================================
-- purchase_orders — country must hold an active PO to attempt produce
-- status: 'active' (usable) | 'consumed' (used by produce, success or fail)
-- ============================================================================
CREATE TABLE purchase_orders (
  id              TEXT PRIMARY KEY,           -- 'PO-<ts>-<rand>'
  country_id      TEXT NOT NULL,
  level           INTEGER NOT NULL,
  product         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  consumed_at     TEXT,
  mentor_apply    TEXT,
  mentor_consume  TEXT
);

CREATE INDEX idx_po_country_status ON purchase_orders(country_id, status);

-- ============================================================================
-- levelup — AND-set of conditions per to_level
-- ============================================================================
CREATE TABLE levelup (
  to_level  INTEGER NOT NULL,
  key       TEXT NOT NULL,
  label     TEXT,
  need      REAL NOT NULL,
  note      TEXT,
  PRIMARY KEY (to_level, key)
);

-- ============================================================================
-- love_table — step function: love value → asset multiplier
-- ============================================================================
CREATE TABLE love_table (
  love        INTEGER PRIMARY KEY,
  multiplier  REAL NOT NULL,
  note        TEXT
);

-- ============================================================================
-- initial_state — per-country starting values for reset()
-- ============================================================================
CREATE TABLE initial_state (
  country_id   TEXT PRIMARY KEY,
  coins        INTEGER NOT NULL DEFAULT 0,
  water        INTEGER NOT NULL DEFAULT 0,
  oil          INTEGER NOT NULL DEFAULT 0,
  wood         INTEGER NOT NULL DEFAULT 0,
  metal        INTEGER NOT NULL DEFAULT 0,
  electricity  INTEGER NOT NULL DEFAULT 0,
  chips        INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);

-- ============================================================================
-- config — key/value game parameters (live-read each request)
-- value stored as TEXT; callers cast as needed (numeric in JS = Number(value))
-- ============================================================================
CREATE TABLE config (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL,
  note   TEXT
);

-- ============================================================================
-- rd_prizes — weighted random prize pool for the RD action
-- type: 'res' (random resource +value units) | 'nofail' (cards +value) | 'coins' (+value)
-- ============================================================================
CREATE TABLE rd_prizes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT NOT NULL,
  value   INTEGER NOT NULL,
  weight  INTEGER NOT NULL DEFAULT 1,
  label   TEXT,
  note    TEXT
);

-- ============================================================================
-- recipes — what resources + semi-products each product needs
-- (4 semi slots match the 'semi1'..'semi4' columns from the sheet)
-- ============================================================================
CREATE TABLE recipes (
  name         TEXT PRIMARY KEY,
  country      TEXT NOT NULL,
  level        INTEGER NOT NULL,
  water        INTEGER NOT NULL DEFAULT 0,
  oil          INTEGER NOT NULL DEFAULT 0,
  wood         INTEGER NOT NULL DEFAULT 0,
  metal        INTEGER NOT NULL DEFAULT 0,
  electricity  INTEGER NOT NULL DEFAULT 0,
  chips        INTEGER NOT NULL DEFAULT 0,
  semi1        TEXT,
  semi2        TEXT,
  semi3        TEXT,
  semi4        TEXT,
  note         TEXT
);

CREATE INDEX idx_recipes_country_level ON recipes(country, level);
