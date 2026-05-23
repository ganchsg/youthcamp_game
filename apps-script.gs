/**
 * Youth Camp Scoreboard — Google Apps Script backend
 *
 * Setup (first time):
 *  1. Open a Google Sheet (create new one).
 *  2. Extensions → Apps Script
 *  3. Paste this whole file as Code.gs (overwrite default).
 *  4. Run `setup()` once (allow permissions on first run).
 *  5. Deploy → New deployment → Type: Web app
 *       Execute as: Me / Who has access: Anyone
 *     → Copy the Web App URL.
 *  6. Paste that URL into WEBAPP_URL inside index.html.
 *
 * Migrating (after pasting new code):
 *  - Run `migrate()` once. Adds any missing columns without touching data.
 *  - Then redeploy: 部署 → 管理部署 → 铅笔 → 版本: 新版本 → 部署
 */

const COUNTRIES_HEADERS = [
  'country_id', 'name', 'flag', 'domain', 'level',
  'coins', 'asset', 'love', 'honor',
  'water', 'oil', 'wood', 'metal', 'electricity', 'chips',
  'l1_orders', 'l2_orders', 'l3_orders', 'l4_orders', 'shipments',
  'no_fail_cards', 'last_draw_at'
];

const PRODUCTS_HEADERS = ['country_id', 'level', 'name', 'qty'];
const LOG_HEADERS = ['timestamp', 'mentor', 'country_id', 'event', 'field', 'delta', 'before', 'after', 'detail', 'reason'];
const TOKEN_HEADERS = ['country_id', 'token', 'note'];
// price_jp    = JP-specific buy price for resources (fallback to price if blank).
// asset_value = 估值, used for asset/NAV display (fallback to price if blank).
const PRICES_HEADERS = ['item_type', 'item_key', 'unit_size', 'price', 'price_jp', 'sell_price', 'asset_value', 'note'];
const DEFAULT_SELL_RATIO = 0.6;  // mentor pays 60% of buy price when buying back from country

// ==== Purchase Orders ====
// status: 'active' (usable) | 'consumed' (used by produce, success or fail)
const PURCHASE_HEADERS = ['id', 'country_id', 'level', 'product', 'status', 'created_at', 'consumed_at', 'mentor_apply', 'mentor_consume'];

// ==== Level-up rules ====
// One row per condition. Multiple rows with the same to_level form the AND-set
// of requirements. `key` matches a country field (coins / l1_orders / love /
// shipments etc.) or the derived `l4_distinct`.
const LEVELUP_HEADERS = ['to_level', 'key', 'label', 'need', 'note'];
const DEFAULT_LEVELUP = [
  [2, 'l1_orders',  '完成 L1 产品', 10,    ''],
  [2, 'coins',      '金币',         20000, ''],
  [2, 'shipments',  '成功运输',     5,     ''],
  [3, 'l2_orders',  '完成 L2 产品', 5,     ''],
  [3, 'coins',      '金币',         50000, ''],
  [4, 'l3_orders',  '完成 L3 产品', 3,     ''],
  [4, 'coins',      '金币',         80000, ''],
  [5, 'l4_distinct','不同 L4 产品', 2,     '需做出 2 个不同 L4 产品'],
  [5, 'coins',      '金币',         80000, ''],
  [5, 'love',       '爱心值',       1,     ''],
  [5, 'honor',      '荣誉值',       1,     ''],
];

// ==== Love Table (asset multiplier per love value, step function) ====
// For love value V, multiplier = highest row where row.love ≤ V (else 1.0).
// E.g. table [0→1.0, 1→1.1, 3→1.15]: love=2 → 1.1, love=3 → 1.15, love=5 → 1.15
const LOVETABLE_HEADERS = ['love', 'multiplier', 'note'];
const DEFAULT_LOVETABLE = [
  [0, 1.00, '基础 · 无加成'],
  [1, 1.10, '+10%'],
  [2, 1.12, '+12%'],
  [3, 1.15, '+15%'],
  [5, 1.20, '+20%'],
];

// ==== Initial State (per-country starting values for reset) ====
// Mentor edits this sheet to tweak the starting wealth/resources of each country.
const INITSTATE_HEADERS = ['country_id', 'coins', 'water', 'oil', 'wood', 'metal', 'electricity', 'chips', 'note'];
const DEFAULT_INITSTATE = [
  ['my', 10000, 1600, 1600, 1600, 1600, 1600, 1600, '资源国 — 起始 1600/资源'],
  ['kr', 10000, 0,    0,    0,    0,    0,    0,    '科技国 — L1 卖银行 +10% 溢价 (写入 Prices.sell_price)'],
  ['jp', 10000, 0,    0,    0,    0,    0,    0,    '医疗国 — 买资源 -10% (price_jp=450)'],
  ['us', 20000, 0,    0,    0,    0,    0,    0,    '金融国 — 起始金币 2 倍'],
];

// ==== Config (key/value, live-read each request) ====
const CONFIG_HEADERS = ['key', 'value', 'note'];
const DEFAULT_CONFIG = [
  ['purchase_cost',  100, '申请一张采购单的金币成本'],
  ['purchase_limit',   2, '每个国家同时持有的最大采购单数量'],
  ['rd_cost',        500, '研发部投资的金币成本'],
  ['rd_fail_rate',   0.2, '研发失败概率 (0-1), 失败时金币不退'],
  ['jp_res_price',   450, '日本购买基础资源的统一单价 (留空则回退到 price 列)'],
  ['honor_coin',    1000, '每点荣誉值折算金币 (用于总资产计算)'],
  ['purchase_dup_ratio', 5, '采购单非重复产品权重比 (5 = 新产品被抽到的概率是已持有的 5 倍; 1 = 完全平均)'],
];

// ==== RD Prizes (sheet-driven; weighted random when RD succeeds) ====
// type: 'res' (random resource +value units) | 'nofail' (no-fail cards +value) | 'coins' (+value)
const RDPRIZES_HEADERS = ['type', 'value', 'weight', 'label', 'note'];
const DEFAULT_RD_PRIZES = [
  ['res',    200, 3, '资源包 ×2 (随机一种资源 +200)', '相当于 2 包 100 单位'],
  ['nofail', 1,   3, '免失败运输卡 ×1', '运输前可选用,自动成功'],
  ['nofail', 2,   2, '免失败运输卡 ×2', ''],
  ['coins',  1000, 3, '金币 +1,000', ''],
  ['coins',  2000, 2, '金币 +2,000', ''],
];

// Default prices — only used when Prices sheet doesn't exist.
// Mentor can edit the Prices sheet during the game to adjust on-the-fly.
const DEFAULT_RES_PRICE = 500;    // coins per 100 units (standard); JP pays price_jp=450 (-10%)
const DEFAULT_L1_PRICE  = 1000;   // coins per 1 product
const DEFAULT_L2_PRICE  = 3000;   // coins per 1 product
const DEFAULT_L3_PRICE  = 8000;   // coins per 1 product (asset valuation only — NOT buyable)
const DEFAULT_L4_PRICE  = 20000;  // coins per 1 product (asset valuation only — NOT buyable)
const KR_L1_SELL_BONUS = 1.10;    // KR sells L1 to bank at +10% (baked into sell_price)

// ==== Recipes ====
// Hardcoded fallback only. Authoritative source is the "Recipes" sheet
// (Mentor can edit live; readRecipesFromSheet_() takes precedence).
const RECIPES_HEADERS = ['country', 'level', 'name',
  'water', 'oil', 'wood', 'metal', 'electricity', 'chips',
  'semi1', 'semi2', 'semi3', 'semi4', 'note'];

const RECIPES = {
  // ===== Malaysia =====
  '石油燃料包':       { country: 'my', level: 1, res: { oil: 100, water: 100 }, semi: [] },
  '木材资源包':       { country: 'my', level: 1, res: { wood: 100, oil: 100 }, semi: [] },
  '基础发电机':       { country: 'my', level: 1, res: { metal: 100, oil: 100 }, semi: [] },
  '工业能源核心':     { country: 'my', level: 2, res: { oil: 200, metal: 100, electricity: 100 }, semi: ['石油燃料包'] },
  '港口运输系统':     { country: 'my', level: 2, res: { metal: 200, wood: 100, electricity: 200 }, semi: ['木材资源包'] },
  '工业燃料系统':     { country: 'my', level: 2, res: { oil: 300, electricity: 100 }, semi: ['基础发电机', '石油燃料包'] },
  '太阳能核心':       { country: 'my', level: 3, res: { chips: 200, metal: 200, electricity: 200 }, semi: ['石油燃料包', '工业燃料系统', '实验仪器'] },
  '水力能源系统':     { country: 'my', level: 3, res: { metal: 300, water: 300 }, semi: ['基础发电机', '工业能源核心', '国家安全AI'] },
  '永续能源模组':     { country: 'my', level: 3, res: { chips: 200, electricity: 300, oil: 100 }, semi: ['木材资源包', '港口运输系统', 'AI电脑'] },
  '国家能源网络':     { country: 'my', level: 4, res: { chips: 300, metal: 300, electricity: 300 }, semi: ['太阳能核心', '水力能源系统', 'AI核心系统', '国家安全AI'] },
  '全球能源供应系统': { country: 'my', level: 4, res: { oil: 500, electricity: 200, chips: 200 }, semi: ['永续能源模组', '太阳能核心', '生化医疗系统', '智能机器人'] },

  // ===== Korea =====
  '手机零件':         { country: 'kr', level: 1, res: { metal: 100, electricity: 100 }, semi: [] },
  '基础电脑系统':     { country: 'kr', level: 1, res: { chips: 100, electricity: 100 }, semi: [] },
  '电竞设备':         { country: 'kr', level: 1, res: { metal: 100, chips: 100 }, semi: [] },
  'AI电脑':           { country: 'kr', level: 2, res: { chips: 200, electricity: 200, metal: 100 }, semi: ['基础电脑系统'] },
  '智能监控系统':     { country: 'kr', level: 2, res: { chips: 200, metal: 200 }, semi: ['基础电脑系统'] },
  '云端AI服务器':     { country: 'kr', level: 2, res: { chips: 300, electricity: 100 }, semi: ['手机零件', '基础电脑系统'] },
  '智能机器人':       { country: 'kr', level: 3, res: { chips: 100, metal: 200, electricity: 300 }, semi: ['手机零件', '智能监控系统', '国家安全AI'] },
  '自动驾驶系统':     { country: 'kr', level: 3, res: { chips: 300, electricity: 200, metal: 100 }, semi: ['基础电脑系统', '智能监控系统', '实验仪器'] },
  'AI核心系统':       { country: 'kr', level: 3, res: { chips: 200, electricity: 300, metal: 100 }, semi: ['电竞设备', '云端AI服务器', '工业燃料系统'] },
  '卫星科技系统':     { country: 'kr', level: 4, res: { chips: 500, metal: 200, electricity: 200 }, semi: ['智能机器人', 'AI核心系统', '医疗AI诊断系统', '太空卫星网络'] },
  '火箭控制系统':     { country: 'kr', level: 4, res: { metal: 200, electricity: 500, chips: 200 }, semi: ['自动驾驶系统', 'AI核心系统', '永续能源模组', '生化医疗系统'] },

  // ===== Japan =====
  '医疗用品':         { country: 'jp', level: 1, res: { wood: 100, water: 100 }, semi: [] },
  '药品包':           { country: 'jp', level: 1, res: { water: 100, oil: 100 }, semi: [] },
  '防护装备':         { country: 'jp', level: 1, res: { wood: 100, metal: 100 }, semi: [] },
  '医疗设备':         { country: 'jp', level: 2, res: { metal: 200, electricity: 100, water: 100 }, semi: ['医疗用品'] },
  '实验仪器':         { country: 'jp', level: 2, res: { metal: 200, chips: 300 }, semi: ['防护装备'] },
  '紧急救援系统':     { country: 'jp', level: 2, res: { electricity: 200, metal: 200 }, semi: ['药品包', '医疗用品'] },
  '生化医疗系统':     { country: 'jp', level: 3, res: { chips: 300, water: 200, electricity: 100 }, semi: ['医疗用品', '医疗设备', '工业能源核心'] },
  '疫苗研发核心':     { country: 'jp', level: 3, res: { chips: 100, metal: 200, electricity: 300 }, semi: ['防护装备', '实验仪器', '智能监控系统'] },
  '医疗AI诊断系统':   { country: 'jp', level: 3, res: { chips: 200, electricity: 200, oil: 200 }, semi: ['药品包', '紧急救援系统', '战略无人机'] },
  '全球医疗网络':     { country: 'jp', level: 4, res: { chips: 400, electricity: 200, water: 300 }, semi: ['医疗AI诊断系统', '疫苗研发核心', '太空卫星网络', 'AI核心系统'] },
  '高级医疗产品':     { country: 'jp', level: 4, res: { chips: 400, electricity: 300, water: 200 }, semi: ['生化医疗系统', '疫苗研发核心', '永续能源模组', '太空科技'] },

  // ===== USA =====
  '金融软件':         { country: 'us', level: 1, res: { chips: 100, electricity: 100 }, semi: [] },
  '投资系统':         { country: 'us', level: 1, res: { metal: 100, chips: 100 }, semi: [] },
  '商业网络系统':     { country: 'us', level: 1, res: { electricity: 100, metal: 100 }, semi: [] },
  '国防系统':         { country: 'us', level: 2, res: { metal: 300, chips: 100 }, semi: ['商业网络系统'] },
  '战略无人机':       { country: 'us', level: 2, res: { chips: 300, metal: 200 }, semi: ['金融软件'] },
  '国家安全AI':       { country: 'us', level: 2, res: { chips: 200, electricity: 200 }, semi: ['商业网络系统', '投资系统'] },
  '太空科技':         { country: 'us', level: 3, res: { chips: 200, metal: 200, electricity: 200 }, semi: ['投资系统', '战略无人机', '紧急救援系统'] },
  '宇航系统':         { country: 'us', level: 3, res: { electricity: 300, chips: 300 }, semi: ['金融软件', '国家安全AI', '工业能源核心'] },
  '太空卫星网络':     { country: 'us', level: 3, res: { metal: 400, chips: 200 }, semi: ['商业网络系统', '国防系统', 'AI电脑'] },
  '全球金融AI系统':   { country: 'us', level: 4, res: { metal: 500, chips: 100, electricity: 300 }, semi: ['太空卫星网络', '太空科技', '永续能源模组', '医疗AI诊断系统'] },
  '世界防御网络':     { country: 'us', level: 4, res: { chips: 300, metal: 100, electricity: 500 }, semi: ['太空卫星网络', '宇航系统', '太阳能核心', '智能机器人'] },
};

/** Convert in-memory RECIPES object to sheet rows for seeding. */
function recipesObjectToRows_(obj) {
  const rows = [];
  Object.keys(obj).forEach(name => {
    const r = obj[name];
    const res = r.res || {};
    const semi = r.semi || [];
    rows.push([
      r.country, r.level, name,
      res.water || '', res.oil || '', res.wood || '',
      res.metal || '', res.electricity || '', res.chips || '',
      semi[0] || '', semi[1] || '', semi[2] || '', semi[3] || '',
      '',
    ]);
  });
  return rows;
}

/** Read Recipes sheet → {name: {country, level, res, semi}}. Null if empty/missing. */
function readRecipesFromSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Recipes');
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim()] = i; });
  if (idx.country === undefined || idx.level === undefined || idx.name === undefined) return null;
  const out = {};
  for (let r = 1; r < values.length; r++) {
    const name = String(values[r][idx.name] || '').trim();
    if (!name) continue;
    const country = String(values[r][idx.country] || '').trim().toLowerCase();
    const level = Number(values[r][idx.level]) || 0;
    if (!country || !level) continue;
    const res = {};
    ['water', 'oil', 'wood', 'metal', 'electricity', 'chips'].forEach(k => {
      if (idx[k] !== undefined) {
        const v = Number(values[r][idx[k]]) || 0;
        if (v > 0) res[k] = v;
      }
    });
    const semi = [];
    ['semi1', 'semi2', 'semi3', 'semi4'].forEach(k => {
      if (idx[k] !== undefined) {
        const v = String(values[r][idx[k]] || '').trim();
        if (v) semi.push(v);
      }
    });
    out[name] = { country: country, level: level, res: res, semi: semi };
  }
  return Object.keys(out).length ? out : null;
}

/** Live recipe object — sheet wins, hardcoded RECIPES is the fallback. */
function getRecipes_() {
  return readRecipesFromSheet_() || RECIPES;
}

const ALLOWED_ADJUST_FIELDS = [
  'coins', 'love', 'honor', 'asset',
  'water', 'oil', 'wood', 'metal', 'electricity', 'chips',
  'l1_orders', 'l2_orders', 'l3_orders', 'l4_orders', 'shipments',
  'level', 'no_fail_cards'
];

const RES_KEYS = ['water', 'oil', 'wood', 'metal', 'electricity', 'chips'];
const RES_LABELS_GS = { water:'水', oil:'石油', wood:'木材', metal:'金属', electricity:'电力', chips:'晶片' };

// ============================================================================
// Routing
// ============================================================================
function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action;
    const token = e && e.parameter && e.parameter.country;
    // ===== Readonly (team) mode: ?country=<token> =====
    if (token) {
      const country_id = resolveToken_(token);
      if (!country_id) return json_({ ok: false, error: 'invalid country token' });
      if (action === 'adjust' || action === 'produce') {
        return json_({ ok: false, error: '只读模式不允许修改数据' });
      }
      if (action === 'logs') {
        return readLogs_(country_id, Number(e.parameter.limit) || 100);
      }
      return dumpData_(country_id);
    }
    // ===== Editor mode =====
    if (action === 'adjust') {
      return withLock_(() => adjust_({
        country_id: e.parameter.country_id,
        field: e.parameter.field,
        delta: e.parameter.delta,
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'produce') {
      return withLock_(() => produce_({
        country_id: e.parameter.country_id,
        product: e.parameter.product,
        dice: e.parameter.dice,
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'purchase_apply') {
      return withLock_(() => purchaseApply_({
        country_id: e.parameter.country_id,
        level: e.parameter.level,
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'rd') {
      return withLock_(() => rd_({
        country_id: e.parameter.country_id,
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'reset') {
      return withLock_(() => reset_({
        mentor: e.parameter.mentor,
        confirm: e.parameter.confirm
      }));
    }
    if (action === 'buy') {
      return withLock_(() => buy_({
        country_id: e.parameter.country_id,
        item_type: e.parameter.item_type,
        item_key: e.parameter.item_key,
        qty: e.parameter.qty,
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'sell') {
      return withLock_(() => sell_({
        country_id: e.parameter.country_id,
        item_type: e.parameter.item_type,
        item_key: e.parameter.item_key,
        qty: e.parameter.qty,
        to: e.parameter.to,
        price: e.parameter.price,
        dice: e.parameter.dice,
        use_nofail: e.parameter.use_nofail === '1' || e.parameter.use_nofail === 'true',
        reason: e.parameter.reason,
        mentor: e.parameter.mentor
      }));
    }
    if (action === 'recipes') {
      return json_({ ok: true, recipes: RECIPES });
    }
    if (action === 'logs') {
      return readLogs_(e.parameter.country_id, Number(e.parameter.limit) || 100);
    }
    return dumpData_();
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'adjust') return withLock_(() => adjust_(body));
    if (body.action === 'produce') return withLock_(() => produce_(body));
    if (body.action === 'purchase_apply') return withLock_(() => purchaseApply_(body));
    if (body.action === 'rd') return withLock_(() => rd_(body));
    if (body.action === 'reset') return withLock_(() => reset_(body));
    if (body.action === 'buy') return withLock_(() => buy_(body));
    if (body.action === 'sell') return withLock_(() => sell_(body));
    return json_({ ok: false, error: 'unknown action: ' + body.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function dumpData_(country_id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let countries = readSheet_(ss, 'Countries');
  let products = readSheet_(ss, 'Products');
  const prices = readSheet_(ss, 'Prices');
  const config = readSheet_(ss, 'Config');
  const rd_prizes = readSheet_(ss, 'RDPrizes');
  const love_table = readSheet_(ss, 'LoveTable');
  const level_up = readSheet_(ss, 'LevelUp');
  const recipes_sheet = readSheet_(ss, 'Recipes');
  let purchase_orders = readSheet_(ss, 'PurchaseOrders').filter(o => String(o.status) === 'active');
  if (country_id) {
    countries = countries.filter(c => String(c.country_id) === String(country_id));
    products = products.filter(p => String(p.country_id) === String(country_id));
    purchase_orders = purchase_orders.filter(o => String(o.country_id) === String(country_id));
  }
  return json_({
    ok: true,
    countries: countries,
    products: products,
    prices: prices,
    config: config,
    rd_prizes: rd_prizes,
    love_table: love_table,
    level_up: level_up,
    recipes: recipes_sheet,
    purchase_orders: purchase_orders,
    readonly: !!country_id,
    country_id: country_id || null,
    updated_at: new Date().toISOString()
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ============================================================================
// Actions
// ============================================================================
function adjust_(body) {
  const country_id = body.country_id;
  const field = body.field;
  const delta = Number(body.delta);
  const reason = body.reason ? String(body.reason).trim() : '';
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  if (!country_id || !field) return json_({ ok: false, error: 'missing country_id or field' });
  if (ALLOWED_ADJUST_FIELDS.indexOf(field) === -1) return json_({ ok: false, error: 'field not allowed: ' + field });
  if (!isFinite(delta)) return json_({ ok: false, error: 'delta must be a number' });
  if (!reason) return json_({ ok: false, error: '必须填写调整原因' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份 (A/B/C/D/E)' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Countries');
  if (!sh) return json_({ ok: false, error: 'Countries sheet missing' });

  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  const fieldCol = headers.indexOf(field);
  if (idCol === -1) return json_({ ok: false, error: 'country_id column missing' });
  if (fieldCol === -1) return json_({ ok: false, error: 'field column missing: ' + field });

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(country_id)) {
      const current = Number(values[r][fieldCol]) || 0;
      const newVal = current + delta;
      sh.getRange(r + 1, fieldCol + 1).setValue(newVal);
      writeLog_(mentor, country_id, 'adjust', field, delta, current, newVal,
                `${field} ${current} → ${newVal} (${delta > 0 ? '+' : ''}${delta})`, reason);
      return json_({ ok: true, country_id: country_id, field: field, old: current, new: newVal });
    }
  }
  return json_({ ok: false, error: 'country not found: ' + country_id });
}

function produce_(body) {
  const country_id = body.country_id;
  const productName = body.product;
  const dice = body.dice !== '' && body.dice != null ? Number(body.dice) : null;
  const reason = body.reason ? String(body.reason).trim() : '';
  const mentor = body.mentor ? String(body.mentor).trim() : '';

  if (!country_id) return json_({ ok: false, error: 'missing country_id' });
  if (!productName) return json_({ ok: false, error: 'missing product' });
  if (!reason) return json_({ ok: false, error: '必须填写生产原因' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份 (A/B/C/D/E)' });

  const recipe = getRecipes_()[productName];
  if (!recipe) return json_({ ok: false, error: '未知产品: ' + productName });

  // Dice required, fail only on 1
  if (!dice || dice < 1 || dice > 6) return json_({ ok: false, error: '必须输入骰子结果 (1-6)' });
  const success = (dice !== 1);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const countriesSh = ss.getSheetByName('Countries');
  const productsSh = ss.getSheetByName('Products');
  if (!countriesSh || !productsSh) return json_({ ok: false, error: '缺少 Countries / Products 表' });

  // ===== Require active purchase order =====
  const po = findActivePO_(country_id, productName);
  if (!po) return json_({ ok: false, error: `没有「${productName}」的采购单 — 请先到采购中心申请` });

  // Load country row
  const cValues = countriesSh.getDataRange().getValues();
  const cHeaders = cValues[0];
  const idCol = cHeaders.indexOf('country_id');
  let countryRowIdx = -1;
  for (let r = 1; r < cValues.length; r++) {
    if (String(cValues[r][idCol]) === String(country_id)) { countryRowIdx = r; break; }
  }
  if (countryRowIdx === -1) return json_({ ok: false, error: 'country not found: ' + country_id });

  const colOf = (h) => cHeaders.indexOf(h);

  // Check sufficient base resources
  for (const k in recipe.res) {
    const col = colOf(k);
    if (col === -1) return json_({ ok: false, error: 'resource col missing: ' + k });
    const have = Number(cValues[countryRowIdx][col]) || 0;
    if (have < recipe.res[k]) {
      return json_({ ok: false, error: `资源不足: ${k} ${have} < ${recipe.res[k]}` });
    }
  }

  // Check sufficient semi-products in this country's inventory
  const pValues = productsSh.getDataRange().getValues();
  const pHeaders = pValues[0];
  const pCidCol = pHeaders.indexOf('country_id');
  const pNameCol = pHeaders.indexOf('name');
  const pQtyCol = pHeaders.indexOf('qty');
  const pLvlCol = pHeaders.indexOf('level');

  const semiRowMap = {}; // name -> { rowIdx, qty }
  for (let r = 1; r < pValues.length; r++) {
    if (String(pValues[r][pCidCol]) === String(country_id)) {
      semiRowMap[pValues[r][pNameCol]] = { rowIdx: r, qty: Number(pValues[r][pQtyCol]) || 0 };
    }
  }
  for (const semiName of recipe.semi) {
    const have = (semiRowMap[semiName] && semiRowMap[semiName].qty) || 0;
    if (have < 1) {
      return json_({ ok: false, error: `半成品不足: ${semiName} (库存 ${have})` });
    }
  }

  // ===== APPLY CHANGES (capturing before/after for audit log) =====
  const changes = []; // [{ field, before, after }]

  // 1. Deduct base resources (always, success or fail per spec)
  for (const k in recipe.res) {
    const col = colOf(k);
    const before = Number(cValues[countryRowIdx][col]) || 0;
    const after = before - recipe.res[k];
    countriesSh.getRange(countryRowIdx + 1, col + 1).setValue(after);
    changes.push({ field: k, before: before, after: after });
  }

  // 2. Deduct semi-products (always)
  for (const semiName of recipe.semi) {
    const row = semiRowMap[semiName];
    const before = row.qty;
    const after = before - 1;
    productsSh.getRange(row.rowIdx + 1, pQtyCol + 1).setValue(after);
    changes.push({ field: semiName, before: before, after: after });
  }

  // 3. Consume purchase order (always, one attempt per order)
  markPOConsumed_(po.rowIdx, mentor);

  // 4. Increment l{N}_orders (every attempt, success or fail)
  const lOrderField = 'l' + recipe.level + '_orders';
  const lOrderCol = colOf(lOrderField);
  if (lOrderCol !== -1) {
    const before = Number(cValues[countryRowIdx][lOrderCol]) || 0;
    const after = before + 1;
    countriesSh.getRange(countryRowIdx + 1, lOrderCol + 1).setValue(after);
    changes.push({ field: lOrderField, before: before, after: after });
  }

  // 5. On success: add product
  let productBefore = 0, productAfter = 0;
  if (success) {
    const pc = addProduct_(productsSh, pHeaders, pCidCol, pNameCol, pQtyCol, pLvlCol, country_id, recipe.level, productName);
    productBefore = pc.before; productAfter = pc.after;
    changes.push({ field: productName, before: productBefore, after: productAfter });
  }

  // 6. Log
  const event = success ? 'produce_ok' : 'produce_fail';
  const changeStr = changes.map(c => `${c.field}: ${c.before}→${c.after}`).join(', ');
  const detail = `${success ? '✓制造' : '✗失败'} ${productName} [Lv.${recipe.level}] | 🎲${dice} | 采购单#${po.id}消耗 | ${changeStr}`;
  writeLog_(mentor, country_id, event, productName, success ? 1 : 0, productBefore, productAfter, detail, reason);

  return json_({
    ok: true,
    success: success,
    dice: dice,
    product: productName,
    level: recipe.level,
    po_id: po.id,
    consumed: { res: recipe.res, semi: recipe.semi }
  });
}

// ============================================================================
// Reset — wipe game state back to initial, keep sheets/headers/Prices/Config/RDPrizes
// ============================================================================
function reset_(body) {
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  const confirm = String(body.confirm || '').trim();
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份' });
  if (confirm !== 'RESET') return json_({ ok: false, error: 'confirm 必须传 "RESET"（防止误触）' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Clear Log (keep header)
  const logSh = ss.getSheetByName('Log');
  if (logSh && logSh.getLastRow() > 1) {
    logSh.getRange(2, 1, logSh.getLastRow() - 1, logSh.getLastColumn()).clearContent();
  }

  // 2. Clear Products
  const prodSh = ss.getSheetByName('Products');
  if (prodSh && prodSh.getLastRow() > 1) {
    prodSh.getRange(2, 1, prodSh.getLastRow() - 1, prodSh.getLastColumn()).clearContent();
  }

  // 3. Clear PurchaseOrders
  const poSh = ss.getSheetByName('PurchaseOrders');
  if (poSh && poSh.getLastRow() > 1) {
    poSh.getRange(2, 1, poSh.getLastRow() - 1, poSh.getLastColumn()).clearContent();
  }

  // 4. Load InitialState
  const init = readInitialState_();

  // 5. Reset each country in Countries
  const cSh = ss.getSheetByName('Countries');
  if (!cSh) return json_({ ok: false, error: 'Countries sheet missing' });
  const values = cSh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  if (idCol === -1) return json_({ ok: false, error: 'country_id column missing' });

  // Fields to zero out (game state counters); coins + resources from InitialState
  const zeroFields = ['love', 'honor', 'asset',
                      'l1_orders', 'l2_orders', 'l3_orders', 'l4_orders',
                      'shipments', 'no_fail_cards'];
  const colOf = {};
  headers.forEach((h, i) => { colOf[h] = i; });

  const touched = [];
  for (let r = 1; r < values.length; r++) {
    const cid = String(values[r][idCol] || '').trim().toLowerCase();
    if (!cid) continue;
    const initRow = init[cid] || { coins: 0, water: 0, oil: 0, wood: 0, metal: 0, electricity: 0, chips: 0 };

    // coins + resources from InitialState
    if (colOf.coins >= 0)        cSh.getRange(r + 1, colOf.coins + 1).setValue(Number(initRow.coins) || 0);
    RES_KEYS.forEach(k => {
      if (colOf[k] >= 0)         cSh.getRange(r + 1, colOf[k] + 1).setValue(Number(initRow[k]) || 0);
    });
    // zero everything else
    zeroFields.forEach(f => {
      if (colOf[f] >= 0)         cSh.getRange(r + 1, colOf[f] + 1).setValue(0);
    });
    // level back to 1
    if (colOf.level >= 0)        cSh.getRange(r + 1, colOf.level + 1).setValue(1);
    // clear last_draw_at
    if (colOf.last_draw_at >= 0) cSh.getRange(r + 1, colOf.last_draw_at + 1).setValue('');

    touched.push(cid);
  }

  // 6. Log the reset itself (so there's a trail)
  writeLog_(mentor, '', 'reset', '', 0, null, null,
    `🔄 RESET 重置游戏 · 影响国家: ${touched.join(', ')} · 清: Log/Products/PurchaseOrders, 恢复初始 coins+resources, 归零 love/honor/level/counters/cards`,
    '管理员重置');

  return json_({ ok: true, reset_countries: touched, at: new Date().toISOString() });
}

/** Read InitialState sheet into { country_id → { coins, water, oil, ... } } */
function readInitialState_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('InitialState');
  const map = {};
  // seed with defaults
  DEFAULT_INITSTATE.forEach(row => {
    map[row[0]] = {
      coins: row[1], water: row[2], oil: row[3], wood: row[4],
      metal: row[5], electricity: row[6], chips: row[7]
    };
  });
  if (!sh) return map;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return map;
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  if (idCol === -1) return map;
  for (let r = 1; r < values.length; r++) {
    const cid = String(values[r][idCol] || '').trim().toLowerCase();
    if (!cid) continue;
    const row = {};
    ['coins'].concat(RES_KEYS).forEach(field => {
      const col = headers.indexOf(field);
      if (col !== -1) {
        const v = Number(values[r][col]);
        if (isFinite(v)) row[field] = v;
      }
    });
    map[cid] = Object.assign(map[cid] || {}, row);
  }
  return map;
}

// ============================================================================
// Config + RDPrizes + Purchase Orders helpers
// ============================================================================
function readConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Config');
  const map = {};
  // seed with defaults
  DEFAULT_CONFIG.forEach(r => { map[r[0]] = r[1]; });
  if (!sh) return map;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return map;
  const headers = values[0];
  const kCol = headers.indexOf('key');
  const vCol = headers.indexOf('value');
  if (kCol === -1 || vCol === -1) return map;
  for (let r = 1; r < values.length; r++) {
    const k = String(values[r][kCol] || '').trim();
    const v = values[r][vCol];
    if (k && v !== '' && v != null) map[k] = v;
  }
  return map;
}

function getConfigNum_(key, fallback) {
  const cfg = readConfig_();
  const v = Number(cfg[key]);
  return isFinite(v) ? v : fallback;
}

function readRDPrizes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('RDPrizes');
  if (!sh) {
    // fallback to defaults
    return DEFAULT_RD_PRIZES.map(r => ({ type: r[0], value: Number(r[1]) || 0, weight: Number(r[2]) || 1, label: r[3] || '' }));
  }
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const tCol = headers.indexOf('type');
  const vCol = headers.indexOf('value');
  const wCol = headers.indexOf('weight');
  const lCol = headers.indexOf('label');
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const type = String(values[r][tCol] || '').trim();
    if (!type) continue;
    out.push({
      type: type,
      value: Number(values[r][vCol]) || 0,
      weight: Number(values[r][wCol]) || 1,
      label: lCol !== -1 ? String(values[r][lCol] || '') : ''
    });
  }
  return out;
}

function weightedPickFromPool_(pool) {
  const total = pool.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const p of pool) {
    r -= (Number(p.weight) || 0);
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

// ===== Purchase Orders =====
function ensurePOSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('PurchaseOrders');
  if (!sh) {
    sh = ss.insertSheet('PurchaseOrders');
    sh.getRange(1, 1, 1, PURCHASE_HEADERS.length).setValues([PURCHASE_HEADERS])
      .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
    sh.setFrozenRows(1);
  }
  return sh;
}

function listActivePOs_(country_id) {
  const sh = ensurePOSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const idCol  = headers.indexOf('id');
  const cidCol = headers.indexOf('country_id');
  const lvCol  = headers.indexOf('level');
  const prCol  = headers.indexOf('product');
  const stCol  = headers.indexOf('status');
  const out = [];
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][cidCol]) === String(country_id) && String(values[r][stCol]) === 'active') {
      out.push({
        id: String(values[r][idCol]),
        level: Number(values[r][lvCol]) || 0,
        product: String(values[r][prCol]),
        rowIdx: r
      });
    }
  }
  return out;
}

function findActivePO_(country_id, productName) {
  const arr = listActivePOs_(country_id);
  // pick the oldest first (FIFO) — matches PO id order since ids are timestamped
  for (const po of arr) {
    if (po.product === productName) return po;
  }
  return null;
}

function markPOConsumed_(rowIdx, mentor) {
  const sh = ensurePOSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const stCol = headers.indexOf('status');
  const cuCol = headers.indexOf('consumed_at');
  const mcCol = headers.indexOf('mentor_consume');
  const now = new Date();
  if (stCol !== -1) sh.getRange(rowIdx + 1, stCol + 1).setValue('consumed');
  if (cuCol !== -1) sh.getRange(rowIdx + 1, cuCol + 1).setValue(now);
  if (mcCol !== -1) sh.getRange(rowIdx + 1, mcCol + 1).setValue(mentor || '');
}

function appendPO_(country_id, level, product, mentor) {
  const sh = ensurePOSheet_();
  const id = 'PO-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  sh.appendRow([id, country_id, level, product, 'active', new Date(), '', mentor || '', '']);
  return id;
}

// ============================================================================
// purchase_apply — country pays coins to receive a random product order
// ============================================================================
function purchaseApply_(body) {
  const country_id = body.country_id;
  const level = Number(body.level);
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  const reason = body.reason ? String(body.reason).trim() : '申请采购单';

  if (!country_id) return json_({ ok: false, error: 'missing country_id' });
  if (!isFinite(level) || level < 1 || level > 4) return json_({ ok: false, error: 'level 必须是 1-4' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份' });

  // Live-read config each call (so changes in sheet take effect immediately)
  const cost  = getConfigNum_('purchase_cost', 100);
  const limit = getConfigNum_('purchase_limit', 2);

  // Check existing active orders for this country
  const active = listActivePOs_(country_id);
  if (active.length >= limit) {
    return json_({ ok: false, error: `已持有 ${active.length} 张采购单，达到上限 ${limit} 张` });
  }

  // Build product pool: country + level (from live Recipes sheet)
  const recipes = getRecipes_();
  const pool = Object.keys(recipes).filter(name => {
    const r = recipes[name];
    return r.country === country_id && r.level === level;
  });
  if (pool.length === 0) {
    return json_({ ok: false, error: `${String(country_id).toUpperCase()} 在 L${level} 没有可用产品` });
  }

  // Weighted random: products already in an active PO get weight 1,
  // products not yet held get weight `dupRatio` (default 5). So duplicates
  // are still possible just less likely. Set Config.purchase_dup_ratio=1
  // for fully uniform random.
  const activeProducts = {};
  active.forEach(po => { activeProducts[String(po.product)] = true; });
  const dupRatio = Math.max(1, Number(getConfigNum_('purchase_dup_ratio', 5)) || 5);
  const weights = pool.map(name => activeProducts[name] ? 1 : dupRatio);

  // Charge coins
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Countries');
  if (!sh) return json_({ ok: false, error: 'Countries sheet missing' });
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  const coinsCol = headers.indexOf('coins');
  let rowIdx = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(country_id)) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return json_({ ok: false, error: 'country not found' });

  const curCoins = Number(values[rowIdx][coinsCol]) || 0;
  if (curCoins < cost) {
    return json_({ ok: false, error: `金币不足: 需 ${cost}, 当前 ${curCoins}` });
  }
  const newCoins = curCoins - cost;
  sh.getRange(rowIdx + 1, coinsCol + 1).setValue(newCoins);

  // Pick a random product
  // Weighted random pick
  const totalW = weights.reduce((s, w) => s + w, 0);
  let rnd = Math.random() * totalW;
  let pickedIdx = 0;
  for (let i = 0; i < weights.length; i++) {
    rnd -= weights[i];
    if (rnd <= 0) { pickedIdx = i; break; }
  }
  const product = pool[pickedIdx];

  // Create the PO
  const poId = appendPO_(country_id, level, product, mentor);

  // Log
  const detail = `📋 申请采购单 L${level}: ${product} (花费 ${cost} 金币) #${poId} | 持单 ${active.length + 1}/${limit}`;
  writeLog_(mentor, country_id, 'purchase_apply', product, -cost, curCoins, newCoins, detail, reason);

  return json_({
    ok: true,
    po: { id: poId, level: level, product: product, country_id: country_id, status: 'active' },
    cost: cost,
    new_coins: newCoins,
    active_count: active.length + 1,
    limit: limit
  });
}

// ============================================================================
// rd — research investment: pay coins, 20% fail, 80% random sheet-driven prize
// ============================================================================
function rd_(body) {
  const country_id = body.country_id;
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  const reason = body.reason ? String(body.reason).trim() : '研发部投资';

  if (!country_id) return json_({ ok: false, error: 'missing country_id' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份' });

  const cost = getConfigNum_('rd_cost', 500);
  const failRateRaw = getConfigNum_('rd_fail_rate', 0.2);
  const failRate = Math.max(0, Math.min(1, failRateRaw));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Countries');
  if (!sh) return json_({ ok: false, error: 'Countries sheet missing' });

  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  const coinsCol = headers.indexOf('coins');
  let rowIdx = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(country_id)) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return json_({ ok: false, error: 'country not found' });

  const curCoins = Number(values[rowIdx][coinsCol]) || 0;
  if (curCoins < cost) {
    return json_({ ok: false, error: `金币不足: 需 ${cost}, 当前 ${curCoins}` });
  }

  // Deduct cost FIRST (always — fail or pass)
  const afterCost = curCoins - cost;
  sh.getRange(rowIdx + 1, coinsCol + 1).setValue(afterCost);

  // Roll fail
  if (Math.random() < failRate) {
    const detail = `🧪 研发失败 (花费 ${cost} 金币) | coins: ${curCoins}→${afterCost}`;
    writeLog_(mentor, country_id, 'rd_fail', 'coins', -cost, curCoins, afterCost, detail, reason);
    return json_({
      ok: true,
      success: false,
      cost: cost,
      new_coins: afterCost
    });
  }

  // Pick prize
  const pool = readRDPrizes_();
  if (!pool.length) {
    // No prizes configured — refund? No, spec says no refund. Just return success with no prize.
    return json_({ ok: false, error: 'RDPrizes 表为空，无奖品可领' });
  }
  const prize = weightedPickFromPool_(pool);
  if (!prize) return json_({ ok: false, error: '抽奖失败 — 奖品池权重无效' });

  // Resolve prize → field + value
  let field, value, prizeLabel;
  if (prize.type === 'coins') {
    field = 'coins';
    value = Number(prize.value) || 0;
    prizeLabel = prize.label || `金币 +${value}`;
  } else if (prize.type === 'nofail') {
    field = 'no_fail_cards';
    value = Number(prize.value) || 0;
    prizeLabel = prize.label || `免失败运输卡 ×${value}`;
  } else if (prize.type === 'res') {
    field = RES_KEYS[Math.floor(Math.random() * RES_KEYS.length)];
    value = Number(prize.value) || 0;
    prizeLabel = prize.label
      ? `${prize.label} → ${RES_LABELS_GS[field]} +${value}`
      : `${RES_LABELS_GS[field]} +${value}`;
  } else {
    return json_({ ok: false, error: '未知奖品类型: ' + prize.type });
  }

  // Apply prize
  const v2 = sh.getDataRange().getValues();
  const h2 = v2[0];
  const fCol = h2.indexOf(field);
  if (fCol === -1) return json_({ ok: false, error: 'field column missing: ' + field + ' — 运行 migrate()' });
  const before = Number(v2[rowIdx][fCol]) || 0;
  const after = before + value;
  sh.getRange(rowIdx + 1, fCol + 1).setValue(after);

  const detail = `🧪 研发成功 (花费 ${cost} 金币) → ${prizeLabel} | coins: ${curCoins}→${afterCost}, ${field}: ${before}→${after}`;
  writeLog_(mentor, country_id, 'rd_ok', field, value, before, after, detail, reason);

  return json_({
    ok: true,
    success: true,
    cost: cost,
    new_coins: afterCost,
    prize: {
      type: prize.type,
      field: field,
      value: value,
      label: prizeLabel,
      before: before,
      after: after
    }
  });
}

function addProduct_(productsSh, pHeaders, pCidCol, pNameCol, pQtyCol, pLvlCol, country_id, level, productName, addQty) {
  addQty = (addQty == null) ? 1 : Number(addQty);
  const pValues = productsSh.getDataRange().getValues();
  for (let r = 1; r < pValues.length; r++) {
    if (String(pValues[r][pCidCol]) === String(country_id) && String(pValues[r][pNameCol]) === String(productName)) {
      const before = Number(pValues[r][pQtyCol]) || 0;
      const after = before + addQty;
      productsSh.getRange(r + 1, pQtyCol + 1).setValue(after);
      return { before: before, after: after };
    }
  }
  // append new row
  const row = new Array(pHeaders.length).fill('');
  row[pCidCol] = country_id;
  row[pNameCol] = productName;
  row[pQtyCol] = addQty;
  if (pLvlCol !== -1) row[pLvlCol] = level;
  productsSh.appendRow(row);
  return { before: 0, after: addQty };
}

// ============================================================================
// Buy (from designated buying station)
// ============================================================================
function buildDefaultPrices_() {
  const rows = [];
  const sell = (buy) => Math.floor(buy * DEFAULT_SELL_RATIO);
  const JP_RES = 450;  // JP discount on resource buy (= DEFAULT_RES_PRICE × 0.9, -10%)
  // Columns: item_type, item_key, unit_size, price, price_jp, sell_price, asset_value, note
  // Resources: asset_value = 0 (raw materials don't count toward NAV; convert to products first)
  RES_KEYS.forEach(k => {
    rows.push(['resource', k, 100, DEFAULT_RES_PRICE, JP_RES, sell(DEFAULT_RES_PRICE), 0, RES_LABELS_GS[k]]);
  });
  // Products: asset_value defaults to buy price (manufacturing cost is the baseline)
  // KR L1 gets +10% on sell_price (manufacturing-profit bonus, baked into the row)
  const recipes = getRecipes_();
  Object.keys(recipes).forEach(name => {
    const r = recipes[name];
    const cc = String(r.country).toUpperCase();
    const lvlPrice = r.level === 1 ? DEFAULT_L1_PRICE : r.level === 2 ? DEFAULT_L2_PRICE : r.level === 3 ? DEFAULT_L3_PRICE : DEFAULT_L4_PRICE;
    const baseSell = sell(lvlPrice);
    const sellP = (r.country === 'kr' && r.level === 1) ? Math.floor(baseSell * KR_L1_SELL_BONUS) : baseSell;
    const noteSuffix = (r.country === 'kr' && r.level === 1)
      ? ' · KR +10% 制造溢价'
      : (r.level >= 3 ? ' · 估值' : '');
    rows.push(['l' + r.level, name, 1, lvlPrice, '', sellP, lvlPrice, cc + ' L' + r.level + noteSuffix]);
  });
  return rows;
}

/**
 * Look up buy/sell price for an item.
 * Country override: JP buying a resource → uses price_jp if set (fallback to price).
 * sell_price / asset_value have NO country overrides — set them per-row in the Prices sheet.
 */
function getPriceInfo_(item_type, item_key, country_id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Prices');
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0];
  const typeCol  = headers.indexOf('item_type');
  const keyCol   = headers.indexOf('item_key');
  const unitCol  = headers.indexOf('unit_size');
  const priceCol = headers.indexOf('price');
  const jpCol    = headers.indexOf('price_jp');
  const sellCol  = headers.indexOf('sell_price');
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][typeCol]) === String(item_type) && String(values[r][keyCol]) === String(item_key)) {
      let buy = Number(values[r][priceCol]) || 0;
      if (country_id === 'jp' && jpCol !== -1) {
        const jpRaw = values[r][jpCol];
        if (jpRaw !== '' && jpRaw != null) {
          const jp = Number(jpRaw);
          if (isFinite(jp) && jp > 0) buy = jp;
        }
      }
      return {
        unit_size: Number(values[r][unitCol]) || 1,
        price: buy,
        sell_price: sellCol !== -1 ? (Number(values[r][sellCol]) || 0) : 0
      };
    }
  }
  return null;
}

function buy_(body) {
  const country_id = body.country_id;
  const item_type = body.item_type;
  const item_key = body.item_key;
  const qty = Number(body.qty);
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  const reason = body.reason ? String(body.reason).trim() : '';

  if (!country_id) return json_({ ok: false, error: 'missing country_id' });
  if (!item_type || !item_key) return json_({ ok: false, error: 'missing item' });
  if (['resource', 'l1', 'l2'].indexOf(item_type) === -1) return json_({ ok: false, error: 'item_type 必须是 resource/l1/l2' });
  if (!isFinite(qty) || qty <= 0) return json_({ ok: false, error: 'qty 必须为正数' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份' });
  if (!reason) return json_({ ok: false, error: '必须填写采购原因' });

  const priceInfo = getPriceInfo_(item_type, item_key, country_id);
  if (!priceInfo) return json_({ ok: false, error: '未知商品 (Prices 表中找不到): ' + item_key });

  // Country-specific restriction for L1/L2 products
  if (item_type === 'l1' || item_type === 'l2') {
    const recipe = getRecipes_()[item_key];
    if (!recipe) return json_({ ok: false, error: '未知产品: ' + item_key });
    if (recipe.country !== country_id) {
      return json_({ ok: false, error: item_key + ' 不属于 ' + String(country_id).toUpperCase() + '，只能购买本国产品' });
    }
  }

  const totalUnits = qty * priceInfo.unit_size;  // for resources: qty blocks × 100 = N units
  const totalCost = qty * priceInfo.price;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Countries');
  if (!sh) return json_({ ok: false, error: 'Countries sheet missing' });

  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  const coinsCol = headers.indexOf('coins');

  let rowIdx = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(country_id)) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return json_({ ok: false, error: 'country not found' });

  const curCoins = Number(values[rowIdx][coinsCol]) || 0;
  if (curCoins < totalCost) {
    return json_({ ok: false, error: '金币不足: 需 ' + totalCost + ', 当前 ' + curCoins });
  }

  const newCoins = curCoins - totalCost;
  sh.getRange(rowIdx + 1, coinsCol + 1).setValue(newCoins);

  const changes = [{ field: 'coins', before: curCoins, after: newCoins }];

  if (item_type === 'resource') {
    const resCol = headers.indexOf(item_key);
    if (resCol === -1) return json_({ ok: false, error: 'resource column missing: ' + item_key });
    const before = Number(values[rowIdx][resCol]) || 0;
    const after = before + totalUnits;
    sh.getRange(rowIdx + 1, resCol + 1).setValue(after);
    changes.push({ field: item_key, before: before, after: after });
  } else {
    // l1 or l2 — add to Products sheet (qty units)
    const productsSh = ss.getSheetByName('Products');
    if (!productsSh) return json_({ ok: false, error: 'Products sheet missing' });
    const pValues0 = productsSh.getDataRange().getValues();
    const pHeaders = pValues0[0];
    const pCidCol = pHeaders.indexOf('country_id');
    const pNameCol = pHeaders.indexOf('name');
    const pQtyCol = pHeaders.indexOf('qty');
    const pLvlCol = pHeaders.indexOf('level');
    const lvl = item_type === 'l1' ? 1 : 2;
    const pc = addProduct_(productsSh, pHeaders, pCidCol, pNameCol, pQtyCol, pLvlCol, country_id, lvl, item_key, qty);
    changes.push({ field: item_key, before: pc.before, after: pc.after });
  }

  const tag = item_type === 'resource' ? '基础资源' : ('L' + (item_type === 'l1' ? 1 : 2) + ' 产品');
  const changeStr = changes.map(c => c.field + ': ' + c.before + '→' + c.after).join(', ');
  const qtyStr = item_type === 'resource' ? (totalUnits + '单位') : ('×' + qty);
  const detail = '🛒 采购 [' + tag + '] ' + item_key + ' ' + qtyStr + ' (单价 ' + priceInfo.price + ', 共 ' + totalCost + ' 金币) | ' + changeStr;
  writeLog_(mentor, country_id, 'buy', item_key, -totalCost, curCoins, newCoins, detail, reason);

  return json_({
    ok: true,
    item_key: item_key,
    qty: qty,
    total_units: totalUnits,
    total_cost: totalCost,
    new_coins: newCoins
  });
}

// ============================================================================
// Sell — sell produced products to bank (fixed price) or another country (negotiated)
// ============================================================================
function sell_(body) {
  const seller_id = body.country_id;
  const item_type = body.item_type;   // 'l1' | 'l2' | 'l3' | 'l4'
  const item_key = body.item_key;     // product name
  const qty = Number(body.qty);
  const to = String(body.to || '').trim();  // 'bank' or buyer country_id
  const negotiatedPrice = body.price != null && body.price !== '' ? Number(body.price) : null;
  const dice = body.dice !== '' && body.dice != null ? Number(body.dice) : null;
  const useNofail = !!body.use_nofail;
  const mentor = body.mentor ? String(body.mentor).trim() : '';
  const reason = body.reason ? String(body.reason).trim() : '';

  if (!seller_id) return json_({ ok: false, error: 'missing seller country_id' });
  if (!item_type || !item_key) return json_({ ok: false, error: 'missing item' });
  if (['l1','l2','l3','l4'].indexOf(item_type) === -1) return json_({ ok: false, error: '只能销售 L1/L2/L3/L4 产品，不能售卖资源' });
  if (!isFinite(qty) || qty <= 0) return json_({ ok: false, error: 'qty 必须为正数' });
  if (!to) return json_({ ok: false, error: '必须选择销售对象 (银行或国家)' });
  if (to === seller_id) return json_({ ok: false, error: '不能卖给自己' });
  if (!mentor) return json_({ ok: false, error: '必须先选择导师身份' });
  if (!reason) return json_({ ok: false, error: '必须填写销售原因' });

  // Transport: dice required unless using no-fail card. 4 = fail.
  if (!useNofail) {
    if (!dice || dice < 1 || dice > 6) return json_({ ok: false, error: '运输必须输入骰子结果 (1-6); 4=运输失败' });
  }
  const shipSuccess = useNofail ? true : (dice !== 4);

  // Resolve unit price
  let unitPrice;
  if (to === 'bank') {
    const priceInfo = getPriceInfo_(item_type, item_key);
    if (!priceInfo) return json_({ ok: false, error: '价格表中找不到: ' + item_key });
    unitPrice = priceInfo.sell_price;
    if (!unitPrice || unitPrice <= 0) return json_({ ok: false, error: item_key + ' 的售卖价为 0，无法卖给银行' });
  } else {
    if (negotiatedPrice == null || !isFinite(negotiatedPrice) || negotiatedPrice < 0) {
      return json_({ ok: false, error: '国家间交易必须填写协商单价' });
    }
    unitPrice = negotiatedPrice;
  }
  const totalCoins = qty * unitPrice;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const countriesSh = ss.getSheetByName('Countries');
  const productsSh = ss.getSheetByName('Products');
  if (!countriesSh || !productsSh) return json_({ ok: false, error: '缺少 Countries / Products 表' });

  // Find seller row
  const cValues = countriesSh.getDataRange().getValues();
  const cHeaders = cValues[0];
  const idCol = cHeaders.indexOf('country_id');
  const coinsCol = cHeaders.indexOf('coins');
  const shipCol = cHeaders.indexOf('shipments');
  const nofailCol = cHeaders.indexOf('no_fail_cards');
  let sellerRow = -1, buyerRow = -1;
  for (let r = 1; r < cValues.length; r++) {
    if (String(cValues[r][idCol]) === seller_id) sellerRow = r;
    if (to !== 'bank' && String(cValues[r][idCol]) === to) buyerRow = r;
  }
  if (sellerRow === -1) return json_({ ok: false, error: '卖方国家不存在: ' + seller_id });
  if (to !== 'bank' && buyerRow === -1) return json_({ ok: false, error: '买方国家不存在: ' + to });

  // Check seller has enough product
  const pValues = productsSh.getDataRange().getValues();
  const pHeaders = pValues[0];
  const pCidCol = pHeaders.indexOf('country_id');
  const pNameCol = pHeaders.indexOf('name');
  const pQtyCol = pHeaders.indexOf('qty');
  const pLvlCol = pHeaders.indexOf('level');
  let sellerProdRow = -1, sellerHave = 0;
  for (let r = 1; r < pValues.length; r++) {
    if (String(pValues[r][pCidCol]) === seller_id && String(pValues[r][pNameCol]) === item_key) {
      sellerProdRow = r;
      sellerHave = Number(pValues[r][pQtyCol]) || 0;
      break;
    }
  }
  if (sellerHave < qty) return json_({ ok: false, error: `库存不足: ${item_key} 当前 ${sellerHave}，需 ${qty}` });

  // Check no-fail card if using one
  if (useNofail) {
    if (nofailCol === -1) return json_({ ok: false, error: 'no_fail_cards 列缺失 — 运行 migrate()' });
    const haveCards = Number(cValues[sellerRow][nofailCol]) || 0;
    if (haveCards < 1) return json_({ ok: false, error: '没有免失败运输卡可用' });
  }

  // If shipping succeeds AND selling to country, check buyer's coins
  if (shipSuccess && to !== 'bank') {
    const buyerCoins = Number(cValues[buyerRow][coinsCol]) || 0;
    if (buyerCoins < totalCoins) {
      return json_({ ok: false, error: `买方金币不足: ${to.toUpperCase()} 当前 ${buyerCoins}，需 ${totalCoins}` });
    }
  }

  // ===== APPLY =====
  const changes = [];

  // 1) Decrement seller's product (always — fail destroys it, success ships it)
  const sellerProdBefore = sellerHave;
  const sellerProdAfter = sellerHave - qty;
  productsSh.getRange(sellerProdRow + 1, pQtyCol + 1).setValue(sellerProdAfter);
  changes.push({ field: `${seller_id}:${item_key}`, before: sellerProdBefore, after: sellerProdAfter });

  // 2) Consume no-fail card if used (always — once committed)
  if (useNofail && nofailCol !== -1) {
    const before = Number(cValues[sellerRow][nofailCol]) || 0;
    const after = before - 1;
    countriesSh.getRange(sellerRow + 1, nofailCol + 1).setValue(after);
    changes.push({ field: `${seller_id}:no_fail_cards`, before: before, after: after });
  }

  let sellerCoinsBefore = Number(cValues[sellerRow][coinsCol]) || 0;
  let sellerCoinsAfter = sellerCoinsBefore;

  if (shipSuccess) {
    // 3) Increment seller's coins
    sellerCoinsAfter = sellerCoinsBefore + totalCoins;
    countriesSh.getRange(sellerRow + 1, coinsCol + 1).setValue(sellerCoinsAfter);
    changes.push({ field: `${seller_id}:coins`, before: sellerCoinsBefore, after: sellerCoinsAfter });

    // 4) +1 shipments
    if (shipCol !== -1) {
      const sBefore = Number(cValues[sellerRow][shipCol]) || 0;
      const sAfter = sBefore + 1;
      countriesSh.getRange(sellerRow + 1, shipCol + 1).setValue(sAfter);
      changes.push({ field: `${seller_id}:shipments`, before: sBefore, after: sAfter });
    }

    // 5) If buyer is country, decrement buyer's coins + increment buyer's product
    if (to !== 'bank') {
      const buyerCoinsBefore = Number(cValues[buyerRow][coinsCol]) || 0;
      const buyerCoinsAfter = buyerCoinsBefore - totalCoins;
      countriesSh.getRange(buyerRow + 1, coinsCol + 1).setValue(buyerCoinsAfter);
      changes.push({ field: `${to}:coins`, before: buyerCoinsBefore, after: buyerCoinsAfter });

      const lvl = item_type === 'l1' ? 1 : item_type === 'l2' ? 2 : item_type === 'l3' ? 3 : 4;
      const pc = addProduct_(productsSh, pHeaders, pCidCol, pNameCol, pQtyCol, pLvlCol, to, lvl, item_key, qty);
      changes.push({ field: `${to}:${item_key}`, before: pc.before, after: pc.after });
    }
  }

  // Log
  const dest = to === 'bank' ? '🏦 银行' : String(to).toUpperCase();
  const tag = shipSuccess ? '💸 运输成功' : '✗ 运输失败';
  const diceStr = useNofail ? '🎫免失败卡' : `🎲${dice}`;
  const changeStr = changes.map(c => c.field + ': ' + c.before + '→' + c.after).join(', ');
  const event = shipSuccess ? 'sell' : 'sell_fail';
  const detail = shipSuccess
    ? `${tag} ${item_key} ×${qty} → ${dest} | ${diceStr} | 单价 ${unitPrice}, 共 ${totalCoins} 金币 | ${changeStr}`
    : `${tag} ${item_key} ×${qty} → ${dest} | ${diceStr} | 产品损失 | ${changeStr}`;
  writeLog_(mentor, seller_id, event, item_key, shipSuccess ? totalCoins : 0, sellerCoinsBefore, sellerCoinsAfter, detail, reason);
  // Buyer mirror only on success
  if (shipSuccess && to !== 'bank') {
    const buyerDetail = `💵 收购 ${item_key} ×${qty} ← ${String(seller_id).toUpperCase()} (单价 ${unitPrice}, 共 ${totalCoins} 金币)`;
    writeLog_(mentor, to, 'sell', item_key, -totalCoins, null, null, buyerDetail, reason);
  }

  return json_({
    ok: true,
    ship_success: shipSuccess,
    dice: dice,
    nofail_used: useNofail,
    seller: seller_id,
    buyer: to,
    item_key: item_key,
    qty: qty,
    unit_price: unitPrice,
    total_coins: shipSuccess ? totalCoins : 0,
    seller_new_coins: sellerCoinsAfter
  });
}

function writeLog_(mentor, country_id, event, field, delta, before, after, detail, reason) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Log');
  if (!sh) return;
  sh.appendRow([new Date(), mentor, country_id, event, field, delta, before, after, detail, reason]);
}

// ============================================================================
// Country tokens (team readonly mode)
// ============================================================================
/**
 * Run this once (or anytime to rotate). Creates random tokens for each country
 * and stores them in the "CountryTokens" sheet.
 *
 * To share the dashboard with a country team, give them a URL like:
 *    https://<your-dashboard>/index.html?country=<token>
 * That URL is readonly: only shows that one country, no buttons to modify.
 */
function generateTokens() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('CountryTokens');
  if (!sh) sh = ss.insertSheet('CountryTokens');
  sh.clear();
  sh.getRange(1, 1, 1, TOKEN_HEADERS.length).setValues([TOKEN_HEADERS])
    .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
  const ids = ['my', 'kr', 'jp', 'us'];
  const names = { my: '马来西亚', kr: '韩国', jp: '日本', us: '美国' };
  const rows = ids.map(id => [id, randomToken_(16), names[id]]);
  sh.getRange(2, 1, rows.length, TOKEN_HEADERS.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, TOKEN_HEADERS.length);
}

function randomToken_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function resolveToken_(token) {
  if (!token) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('CountryTokens');
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0];
  const idCol = headers.indexOf('country_id');
  const tokCol = headers.indexOf('token');
  if (idCol === -1 || tokCol === -1) return null;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][tokCol]) === String(token)) return values[r][idCol];
  }
  return null;
}

function readLogs_(country_id, limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const all = readSheet_(ss, 'Log');
  let filtered = all;
  if (country_id) {
    filtered = all.filter(l => String(l.country_id) === String(country_id));
  }
  // newest first
  filtered.sort((a, b) => {
    const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
    const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
    return tb - ta;
  });
  // serialize timestamps as ISO for transport
  const out = filtered.slice(0, limit).map(l => ({
    timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
    mentor: l.mentor,
    country_id: l.country_id,
    event: l.event,
    field: l.field,
    delta: l.delta,
    before: l.before,
    after: l.after,
    detail: l.detail,
    reason: l.reason
  }));
  return json_({ ok: true, logs: out });
}

// ============================================================================
// Setup / migrate
// ============================================================================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, 'Countries', COUNTRIES_HEADERS, [
    ['my', '马来西亚', '🇲🇾', 'Energy · Resources',          2, 22000, 30000, 3,   2,    400, 300, 200, 500, 100,    0,   8, 2, 0, 0, 6],
    ['kr', '韩国',     '🇰🇷', 'Tech · AI',                    3, 51000, 60000, 1,   4,    100, 200,   0, 600, 400,  800,  12, 5, 1, 0, 9],
    ['jp', '日本',     '🇯🇵', 'Medical · Healthcare',         2, 18000, 26000, 5,   3,    500, 100, 300, 400, 200,  200,   6, 1, 0, 0, 4],
    ['us', '美国',     '🇺🇸', 'Finance · Defense · Space',    3, 80000, 95000, 1,   6,    200, 100,   0, 800, 700, 1200,  10, 5, 2, 0, 8],
  ]);
  ensureSheet_(ss, 'Products', PRODUCTS_HEADERS, [
    ['my', 1, '石油燃料包',     5],
    ['my', 1, '木材资源包',     3],
    ['my', 1, '基础发电机',     2],
    ['my', 2, '工业能源核心',   1],
    ['kr', 2, 'AI电脑',          3],
    ['kr', 2, '智能监控系统',   1],
    ['kr', 3, '智能机器人',     1],
    ['jp', 1, '医疗用品',       4],
    ['jp', 1, '药品包',         3],
    ['jp', 1, '防护装备',       1],
    ['jp', 2, '实验仪器',       2],
    ['us', 2, '国家安全AI',     2],
    ['us', 2, '战略无人机',     2],
    ['us', 3, '太空卫星网络',   1],
    ['us', 3, '太空科技',       1],
  ]);
  ensureSheet_(ss, 'Log', LOG_HEADERS, []);
  ensureSheet_(ss, 'Prices', PRICES_HEADERS, buildDefaultPrices_());
  ensureSheet_(ss, 'Config', CONFIG_HEADERS, DEFAULT_CONFIG);
  ensureSheet_(ss, 'RDPrizes', RDPRIZES_HEADERS, DEFAULT_RD_PRIZES);
  ensureSheet_(ss, 'PurchaseOrders', PURCHASE_HEADERS, []);
  ensureSheet_(ss, 'InitialState', INITSTATE_HEADERS, DEFAULT_INITSTATE);
  ensureSheet_(ss, 'LoveTable', LOVETABLE_HEADERS, DEFAULT_LOVETABLE);
  ensureSheet_(ss, 'LevelUp', LEVELUP_HEADERS, DEFAULT_LEVELUP);
  ensureSheet_(ss, 'Recipes', RECIPES_HEADERS, recipesObjectToRows_(RECIPES));
}

function migrate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  migrateSheet_(ss, 'Countries', COUNTRIES_HEADERS);
  migrateSheet_(ss, 'Products', PRODUCTS_HEADERS);
  migrateSheet_(ss, 'Log', LOG_HEADERS);
  migrateSheet_(ss, 'Prices', PRICES_HEADERS);
  migrateSheet_(ss, 'Config', CONFIG_HEADERS);
  migrateSheet_(ss, 'RDPrizes', RDPRIZES_HEADERS);
  migrateSheet_(ss, 'PurchaseOrders', PURCHASE_HEADERS);
  migrateSheet_(ss, 'InitialState', INITSTATE_HEADERS);
  migrateSheet_(ss, 'LoveTable', LOVETABLE_HEADERS);
  migrateSheet_(ss, 'LevelUp', LEVELUP_HEADERS);
  migrateSheet_(ss, 'Recipes', RECIPES_HEADERS);
  ensureDefaultPrices_();
  ensureDefaultConfig_();
  ensureDefaultRDPrizes_();
  ensureDefaultInitialState_();
  ensureDefaultLoveTable_();
  ensureDefaultLevelUp_();
  ensureDefaultRecipes_();
}

/** Seed Recipes sheet with defaults if empty. */
function ensureDefaultRecipes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Recipes');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    const rows = recipesObjectToRows_(RECIPES);
    sh.getRange(2, 1, rows.length, RECIPES_HEADERS.length).setValues(rows);
  }
}

/** Seed LevelUp with defaults if empty. */
function ensureDefaultLevelUp_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('LevelUp');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, DEFAULT_LEVELUP.length, LEVELUP_HEADERS.length).setValues(DEFAULT_LEVELUP);
  }
}

/** Seed LoveTable with defaults if empty. */
function ensureDefaultLoveTable_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('LoveTable');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, DEFAULT_LOVETABLE.length, LOVETABLE_HEADERS.length).setValues(DEFAULT_LOVETABLE);
  }
}

/** Seed InitialState with defaults if empty. */
function ensureDefaultInitialState_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('InitialState');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, DEFAULT_INITSTATE.length, INITSTATE_HEADERS.length).setValues(DEFAULT_INITSTATE);
  }
}

/** Append any missing default Config rows (idempotent). */
function ensureDefaultConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Config');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, DEFAULT_CONFIG.length, CONFIG_HEADERS.length).setValues(DEFAULT_CONFIG);
    return;
  }
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const kCol = headers.indexOf('key');
  const existing = {};
  for (let r = 1; r < values.length; r++) {
    const k = String(values[r][kCol] || '').trim();
    if (k) existing[k] = true;
  }
  const toAdd = DEFAULT_CONFIG.filter(row => !existing[row[0]]);
  if (toAdd.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, CONFIG_HEADERS.length).setValues(toAdd);
  }
}

/** If RDPrizes sheet is empty, seed with defaults (don't touch existing rows). */
function ensureDefaultRDPrizes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('RDPrizes');
  if (!sh) return;
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, DEFAULT_RD_PRIZES.length, RDPRIZES_HEADERS.length).setValues(DEFAULT_RD_PRIZES);
  }
}

/**
 * Repair Products sheet — match each product's `name` against RECIPES keys.
 * If a product name fails to match exactly but matches after stripping whitespace,
 * rewrite the cell to the canonical RECIPES key. Safe to re-run.
 *
 * Run when you see "price = 0" for products that should have a price (e.g. AI电脑).
 */
function repairProductNames() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Products');
  if (!sh) { Logger.log('No Products sheet'); return; }
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0];
  const nameCol = headers.indexOf('name');
  if (nameCol === -1) { Logger.log('No name column'); return; }

  // Build a normalized lookup from live recipes (sheet > fallback)
  const recipes = getRecipes_();
  const canonical = {};   // normalized → canonical key
  Object.keys(recipes).forEach(k => {
    canonical[normalize_(k)] = k;
  });

  const fixes = [];
  for (let r = 1; r < values.length; r++) {
    const cur = values[r][nameCol];
    if (cur == null || cur === '') continue;
    const sCur = String(cur);
    if (recipes[sCur]) continue;  // exact match — fine
    const norm = normalize_(sCur);
    const canon = canonical[norm];
    if (canon && canon !== sCur) {
      sh.getRange(r + 1, nameCol + 1).setValue(canon);
      fixes.push(sCur + ' → ' + canon);
    }
  }
  Logger.log('Fixed product names: ' + (fixes.length ? fixes.join(', ') : '(none)'));
}

function normalize_(s) {
  return String(s).replace(/\s+/g, '').replace(/[·\.\-_]/g, '').toLowerCase();
}

/** Append any missing default-price rows to Prices sheet (idempotent). */
function ensureDefaultPrices_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Prices');
  if (!sh) return;
  const defaults = buildDefaultPrices_();
  if (sh.getLastRow() <= 1) {
    // empty sheet — populate all
    sh.getRange(2, 1, defaults.length, PRICES_HEADERS.length).setValues(defaults);
    return;
  }
  // build existing key set
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const typeCol = headers.indexOf('item_type');
  const keyCol = headers.indexOf('item_key');
  const existing = {};
  for (let r = 1; r < values.length; r++) {
    existing[String(values[r][typeCol]) + ':' + String(values[r][keyCol])] = true;
  }
  // collect rows that don't exist yet
  const toAdd = defaults.filter(row => !existing[row[0] + ':' + row[1]]);
  if (toAdd.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, PRICES_HEADERS.length).setValues(toAdd);
  }
  // backfill sell_price / price_jp / asset_value for any rows where they're blank
  const v2 = sh.getDataRange().getValues();
  const h2 = v2[0];
  const sellCol    = h2.indexOf('sell_price');
  const priceCol   = h2.indexOf('price');
  const typeCol2   = h2.indexOf('item_type');
  const jpCol      = h2.indexOf('price_jp');
  const assetCol   = h2.indexOf('asset_value');
  if (sellCol === -1 || priceCol === -1) return;
  const JP_RES = 450;  // -10%
  const keyCol2 = h2.indexOf('item_key');
  const livRecipes = getRecipes_();
  for (let r = 1; r < v2.length; r++) {
    const type = String(v2[r][typeCol2] || '');
    const key  = keyCol2 !== -1 ? String(v2[r][keyCol2] || '') : '';
    const buy  = Number(v2[r][priceCol]) || 0;
    const cur  = v2[r][sellCol];
    if (cur === '' || cur === null) {
      // KR L1 gets +10% bonus baked in
      const recipe = key && livRecipes[key];
      const isKrL1 = recipe && recipe.country === 'kr' && recipe.level === 1 && type === 'l1';
      const baseSell = Math.floor(buy * DEFAULT_SELL_RATIO);
      const sellVal = isKrL1 ? Math.floor(baseSell * KR_L1_SELL_BONUS) : baseSell;
      sh.getRange(r + 1, sellCol + 1).setValue(sellVal);
    }
    // Backfill price_jp = 450 for resource rows missing it
    if (jpCol !== -1 && type === 'resource') {
      const j = v2[r][jpCol];
      if (j === '' || j === null) {
        sh.getRange(r + 1, jpCol + 1).setValue(JP_RES);
      }
    }
    // Backfill asset_value for any row missing it.
    //   resources → 0 (raw materials don't count toward NAV)
    //   products  → price (manufacturing cost baseline; mentor can override)
    if (assetCol !== -1) {
      const a = v2[r][assetCol];
      if (a === '' || a === null) {
        const av = (type === 'resource') ? 0 : buy;
        sh.getRange(r + 1, assetCol + 1).setValue(av);
      }
    }
  }
}

function ensureSheet_(ss, name, headers, sampleRows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
    if (sampleRows && sampleRows.length) {
      sh.getRange(2, 1, sampleRows.length, headers.length).setValues(sampleRows);
    }
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, headers.length);
  }
}

function migrateSheet_(ss, name, expected) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, expected.length).setValues([expected])
      .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
    sh.setFrozenRows(1);
    return;
  }
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) {
    sh.getRange(1, 1, 1, expected.length).setValues([expected])
      .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
    sh.setFrozenRows(1);
    return;
  }
  const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = expected.filter(h => current.indexOf(h) === -1);
  if (missing.length === 0) return;
  const start = lastCol + 1;
  sh.getRange(1, start, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#1a1e29').setFontColor('#e8eaf0');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(start, missing.length);
}

function readSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(r => r.some(c => c !== '' && c !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
