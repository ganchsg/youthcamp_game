# Youth Camp — Cloudflare Workers + D1 backend

Drop-in replacement for `apps-script.gs`. Same query-string API, much faster
(D1 sub-100 ms vs Sheets multi-second).

```
worker/
  wrangler.toml      # CF config, D1 binding
  schema.sql         # CREATE TABLE × 13
  seed.sql           # default config / recipes / prices / countries
  src/
    index.ts         # router + CORS + auth
    types.ts         # row types
    util.ts          # json, tokens, recipes, prices, log helpers
    actions/         # 8 actions, one file each
      dump.ts adjust.ts produce.ts purchase.ts rd.ts buy.ts sell.ts reset.ts logs.ts
```

## First-time deploy

Prereqs: Node.js 18+, a Cloudflare account.

```sh
cd worker
npm install                 # wrangler + types
npx wrangler login           # OAuth in browser, one-time

# 1) Create the D1 database — copy the printed database_id
npx wrangler d1 create youthcamp
# → paste the id into wrangler.toml [[d1_databases]] database_id

# 2) Apply schema (remote = production D1; --local for the dev sandbox)
npx wrangler d1 execute youthcamp --remote --file=./schema.sql

# 3a) FRESH start with default game data
npx wrangler d1 execute youthcamp --remote --file=./seed.sql

# 3b) OR migrate from your existing Google Sheet (see "Data migration" below)
# Skip seed.sql in that case — the import script supplies all rows.

# 4) Deploy the Worker
npx wrangler deploy
# → prints something like https://youthcamp.<your-subdomain>.workers.dev
```

Paste that URL into `WEBAPP_URL` in `../index.html`. Done.

## Data migration (Google Sheets → D1)

If you have a live game in Sheets and want to bring its state over:

```sh
# from repo root, not worker/
# 1) Export tokens (the API doesn't expose them — for security):
#    Open the Google Sheet → CountryTokens tab → File → Download → CSV
#    → save as country_tokens.csv next to import_from_sheets.py
#    Same for MentorTokens → mentor_tokens.csv

# 2) Build a single import.sql from the live Apps Script backend
python import_from_sheets.py \
  --webapp 'https://script.google.com/macros/s/.../exec' \
  --mentor '<any mentor token>' \
  --country-csv country_tokens.csv \
  --mentor-csv mentor_tokens.csv \
  --out import.sql

# 3) Apply it (run schema.sql FIRST if the D1 is fresh; skip seed.sql)
cd worker
npx wrangler d1 execute youthcamp --remote --file=../import.sql
```

## Without migration: minting tokens by hand

`seed.sql` does NOT seed `country_tokens` / `mentor_tokens`. After deploy:

```sh
# Mint mentor tokens (A/B/C/D/E). Pick any random 16-char strings.
npx wrangler d1 execute youthcamp --remote --command="
  INSERT INTO mentor_tokens (mentor_id, token, note) VALUES
    ('A', 'PASTE-RANDOM-16-CHARS', '导师 A'),
    ('B', 'PASTE-RANDOM-16-CHARS', '导师 B'),
    ('C', 'PASTE-RANDOM-16-CHARS', '导师 C'),
    ('D', 'PASTE-RANDOM-16-CHARS', '导师 D'),
    ('E', 'PASTE-RANDOM-16-CHARS', '导师 E');
"

# Mint readonly country tokens (one per country)
npx wrangler d1 execute youthcamp --remote --command="
  INSERT INTO country_tokens (country_id, token, note) VALUES
    ('my', 'PASTE-RANDOM-16-CHARS', '马来西亚'),
    ('kr', 'PASTE-RANDOM-16-CHARS', '韩国'),
    ('jp', 'PASTE-RANDOM-16-CHARS', '日本'),
    ('us', 'PASTE-RANDOM-16-CHARS', '美国');
"
```

Then share `https://<your-host>/index.html?mentor=<token>` with mentors and
`...?country=<token>` with each country team.

## Local dev

```sh
cd worker
npx wrangler dev          # spins up http://localhost:8787 with a local D1
# To seed the local D1:
npx wrangler d1 execute youthcamp --local --file=./schema.sql
npx wrangler d1 execute youthcamp --local --file=./seed.sql
```

Point `WEBAPP_URL` at `http://localhost:8787` while developing.

## Live editing of game parameters

The GAS version let mentors edit Recipes / Prices / Config / LevelUp sheets
during the game. In D1 you can do the same with raw SQL — examples:

```sh
# Bump R&D fail rate to 30%
npx wrangler d1 execute youthcamp --remote \
  --command="UPDATE config SET value='0.3' WHERE key='rd_fail_rate';"

# Change AI电脑 sell price to bank
npx wrangler d1 execute youthcamp --remote \
  --command="UPDATE prices SET sell_price=2200 WHERE item_type='l2' AND item_key='AI电脑';"

# Re-seed defaults (clobbers any live tweaks!)
npx wrangler d1 execute youthcamp --remote --file=./seed.sql
```

The Worker reads `config` / `prices` / `recipes` live on every request, so
edits take effect on the next mentor click.

## Reset for a new session

The `?action=reset&confirm=RESET&mentor=<token>` endpoint wipes `log`,
`products`, `purchase_orders` and restores `countries` from `initial_state`.
Same as the GAS version.

## API surface (parity with apps-script.gs)

All endpoints accept GET (querystring) and POST (JSON body).

| Action          | Auth        | Effect                                            |
|-----------------|-------------|---------------------------------------------------|
| (no `action`)   | mentor OR country | Full dump (readonly if country token)       |
| `adjust`        | mentor      | ±field on one country (whitelist enforced)        |
| `produce`       | mentor      | Spend resources+semi+PO to attempt a product      |
| `purchase_apply`| mentor      | Buy a random PO at the country's level             |
| `rd`            | mentor      | R&D lottery (fail rate from config)               |
| `buy`           | mentor      | Buy from bank (resource/L1/L2/L3)                 |
| `sell`          | mentor      | Sell to bank or country (dice for shipping)       |
| `reset`         | mentor      | Wipe game state, restore initial_state            |
| `logs`          | mentor OR country | Read audit log (filtered by country)        |
| `recipes`       | mentor      | Raw recipe dump (kept for parity, unused by UI)   |

## Tail logs in production

```sh
npx wrangler tail
```

## Roll back

Old `apps-script.gs` is still in the repo. To revert: change `WEBAPP_URL` in
`index.html` back to the GAS URL. Nothing else to undo.
