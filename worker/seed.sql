-- ============================================================================
-- Youth Camp — seed data (mirrors DEFAULT_* + RECIPES from apps-script.gs)
-- Apply AFTER schema.sql:
--   wrangler d1 execute youthcamp --remote --file=./seed.sql
--
-- Idempotent: uses INSERT OR REPLACE so re-running just overwrites the rows.
-- Does NOT touch the `log` or `purchase_orders` tables.
-- Does NOT seed `country_tokens` / `mentor_tokens` — generate those by:
--   (a) running the migration script (../import_from_sheets.py), OR
--   (b) inserting them by hand after deploy. See worker/README.md.
-- ============================================================================

-- ----- countries (initial demo values; reset() will recompute coins/resources
--       from initial_state below) -----
INSERT OR REPLACE INTO countries
  (country_id, name, flag, domain, level, coins, asset, love, honor,
   water, oil, wood, metal, electricity, chips,
   l1_orders, l2_orders, l3_orders, l4_orders, shipments, no_fail_cards, last_draw_at)
VALUES
  ('my', '马来西亚', '🇲🇾', 'Energy · Resources',       2, 22000, 30000, 3, 2,  400, 300, 200, 500, 100,    0,  8, 2, 0, 0,  6, 0, NULL),
  ('kr', '韩国',     '🇰🇷', 'Tech · AI',                 3, 51000, 60000, 1, 4,  100, 200,   0, 600, 400,  800, 12, 5, 1, 0,  9, 0, NULL),
  ('jp', '日本',     '🇯🇵', 'Medical · Healthcare',      2, 18000, 26000, 5, 3,  500, 100, 300, 400, 200,  200,  6, 1, 0, 0,  4, 0, NULL),
  ('us', '美国',     '🇺🇸', 'Finance · Defense · Space', 3, 80000, 95000, 1, 6,  200, 100,   0, 800, 700, 1200, 10, 5, 2, 0,  8, 0, NULL);

-- ----- products (starting inventory shown on dashboard load) -----
INSERT OR REPLACE INTO products (country_id, name, level, qty) VALUES
  ('my', '石油燃料包',     1, 5),
  ('my', '木材资源包',     1, 3),
  ('my', '基础发电机',     1, 2),
  ('my', '工业能源核心',   2, 1),
  ('kr', 'AI电脑',         2, 3),
  ('kr', '智能监控系统',   2, 1),
  ('kr', '智能机器人',     3, 1),
  ('jp', '医疗用品',       1, 4),
  ('jp', '药品包',         1, 3),
  ('jp', '防护装备',       1, 1),
  ('jp', '实验仪器',       2, 2),
  ('us', '国家安全AI',     2, 2),
  ('us', '战略无人机',     2, 2),
  ('us', '太空卫星网络',   3, 1),
  ('us', '太空科技',       3, 1);

-- ----- config -----
INSERT OR REPLACE INTO config (key, value, note) VALUES
  ('purchase_cost',      '100',  '申请一张采购单的金币成本'),
  ('purchase_limit_l1',  '2',    '国家 Lv.1 时同时持有最大采购单数量'),
  ('purchase_limit_l2',  '3',    '国家 Lv.2 时同时持有最大采购单数量'),
  ('purchase_limit_l3',  '5',    '国家 Lv.3 时同时持有最大采购单数量'),
  ('purchase_limit_l4',  '5',    '国家 Lv.4 时同时持有最大采购单数量 (最高级)'),
  ('rd_cost',            '500',  '研发部投资的金币成本'),
  ('rd_fail_rate',       '0.2',  '研发失败概率 (0-1), 失败时金币不退'),
  ('jp_res_price',       '450',  '日本购买基础资源的统一单价 (留空则回退到 price 列)'),
  ('honor_coin',         '1000', '每点荣誉值折算金币 (用于总资产计算)'),
  ('purchase_dup_ratio', '5',    '采购单非重复产品权重比 (5 = 新产品被抽到的概率是已持有的 5 倍; 1 = 完全平均)');

-- ----- rd_prizes (weighted random when RD succeeds) -----
DELETE FROM rd_prizes;
INSERT INTO rd_prizes (type, value, weight, label, note) VALUES
  ('res',    200, 3, '资源包 ×2 (随机一种资源 +200)', '相当于 2 包 100 单位'),
  ('nofail',   1, 3, '免失败运输卡 ×1',               '运输前可选用,自动成功'),
  ('nofail',   2, 2, '免失败运输卡 ×2',               ''),
  ('coins', 1000, 3, '金币 +1,000',                  ''),
  ('coins', 2000, 2, '金币 +2,000',                  '');

-- ----- levelup conditions (to_level=5 = Lv.4 终极完成目标; level 永远不会真升到 5) -----
INSERT OR REPLACE INTO levelup (to_level, key, label, need, note) VALUES
  (2, 'l1_orders',   '完成 L1 产品',  10,     ''),
  (2, 'coins',       '金币',          20000,  ''),
  (2, 'shipments',   '成功运输',      5,      ''),
  (3, 'l2_orders',   '完成 L2 产品',  5,      ''),
  (3, 'coins',       '金币',          50000,  ''),
  (4, 'l3_orders',   '完成 L3 产品',  3,      ''),
  (4, 'coins',       '金币',          80000,  ''),
  (5, 'l4_distinct', '不同 L4 产品',  2,      'Lv.4 终极完成目标 (level 不会真升到 5)'),
  (5, 'coins',       '金币',          120000, 'Lv.4 终极完成目标'),
  (5, 'love',        '爱心值',        1,      'Lv.4 终极完成目标'),
  (5, 'honor',       '荣誉值',        30,     'Lv.4 终极完成目标');

-- ----- love_table (step function: love → asset multiplier) -----
INSERT OR REPLACE INTO love_table (love, multiplier, note) VALUES
  (0, 1.00, '基础 · 无加成'),
  (1, 1.10, '+10%'),
  (2, 1.12, '+12%'),
  (3, 1.15, '+15%'),
  (5, 1.20, '+20%');

-- ----- initial_state (used by reset()) -----
INSERT OR REPLACE INTO initial_state (country_id, coins, water, oil, wood, metal, electricity, chips, note) VALUES
  ('my', 10000, 400, 400, 400, 400, 400, 400, '资源国 — 起始 400/资源'),
  ('kr', 10000,   0,   0,   0,   0,   0,   0, '科技国 — L1 卖银行 +10% 溢价 (写入 prices.sell_price)'),
  ('jp', 10000,   0,   0,   0,   0,   0,   0, '医疗国 — 买资源 -10% (price_jp=450)'),
  ('us', 20000,   0,   0,   0,   0,   0,   0, '金融国 — 起始金币 2 倍');

-- ============================================================================
-- recipes (canonical product → required resources + semi-products)
-- ============================================================================
INSERT OR REPLACE INTO recipes (name, country, level, water, oil, wood, metal, electricity, chips, semi1, semi2, semi3, semi4, note) VALUES
  -- ===== Malaysia =====
  ('石油燃料包',       'my', 1, 100, 100,   0,   0,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('木材资源包',       'my', 1,   0, 100, 100,   0,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('基础发电机',       'my', 1,   0, 100,   0, 100,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('工业能源核心',     'my', 2,   0, 200,   0, 100, 100,   0, '石油燃料包',    NULL,           NULL,             NULL,             NULL),
  ('港口运输系统',     'my', 2,   0,   0, 100, 200, 200,   0, '木材资源包',    NULL,           NULL,             NULL,             NULL),
  ('工业燃料系统',     'my', 2,   0, 300,   0,   0, 100,   0, '基础发电机',    '石油燃料包',   NULL,             NULL,             NULL),
  ('太阳能核心',       'my', 3,   0,   0,   0, 200, 200, 200, '石油燃料包',    '工业燃料系统', '实验仪器',       NULL,             NULL),
  ('水力能源系统',     'my', 3, 300,   0,   0, 300,   0,   0, '基础发电机',    '工业能源核心', '国家安全AI',     NULL,             NULL),
  ('永续能源模组',     'my', 3,   0, 100,   0,   0, 300, 200, '木材资源包',    '港口运输系统', 'AI电脑',         NULL,             NULL),
  ('国家能源网络',     'my', 4,   0,   0,   0, 300, 300, 300, '太阳能核心',    '水力能源系统', 'AI核心系统',     '国家安全AI',     NULL),
  ('全球能源供应系统', 'my', 4,   0, 500,   0,   0, 200, 200, '永续能源模组',  '太阳能核心',   '生化医疗系统',   '智能机器人',     NULL),

  -- ===== Korea =====
  ('手机零件',         'kr', 1,   0,   0,   0, 100, 100,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('基础电脑系统',     'kr', 1,   0,   0,   0,   0, 100, 100, NULL,            NULL,           NULL,             NULL,             NULL),
  ('电竞设备',         'kr', 1,   0,   0,   0, 100,   0, 100, NULL,            NULL,           NULL,             NULL,             NULL),
  ('AI电脑',           'kr', 2,   0,   0,   0, 100, 200, 200, '基础电脑系统',  NULL,           NULL,             NULL,             NULL),
  ('智能监控系统',     'kr', 2,   0,   0,   0, 200,   0, 200, '基础电脑系统',  NULL,           NULL,             NULL,             NULL),
  ('云端AI服务器',     'kr', 2,   0,   0,   0,   0, 100, 300, '手机零件',      '基础电脑系统', NULL,             NULL,             NULL),
  ('智能机器人',       'kr', 3,   0,   0,   0, 200, 300, 100, '手机零件',      '智能监控系统', '国家安全AI',     NULL,             NULL),
  ('自动驾驶系统',     'kr', 3,   0,   0,   0, 100, 200, 300, '基础电脑系统',  '智能监控系统', '实验仪器',       NULL,             NULL),
  ('AI核心系统',       'kr', 3,   0,   0,   0, 100, 300, 200, '电竞设备',      '云端AI服务器', '工业燃料系统',   NULL,             NULL),
  ('卫星科技系统',     'kr', 4,   0,   0,   0, 200, 200, 500, '智能机器人',    'AI核心系统',   '医疗AI诊断系统', '太空卫星网络',   NULL),
  ('火箭控制系统',     'kr', 4,   0,   0,   0, 200, 500, 200, '自动驾驶系统',  'AI核心系统',   '永续能源模组',   '生化医疗系统',   NULL),

  -- ===== Japan =====
  ('医疗用品',         'jp', 1, 100,   0, 100,   0,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('药品包',           'jp', 1, 100, 100,   0,   0,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('防护装备',         'jp', 1,   0,   0, 100, 100,   0,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('医疗设备',         'jp', 2, 100,   0,   0, 200, 100,   0, '医疗用品',      NULL,           NULL,             NULL,             NULL),
  ('实验仪器',         'jp', 2,   0,   0,   0, 200,   0, 300, '防护装备',      NULL,           NULL,             NULL,             NULL),
  ('紧急救援系统',     'jp', 2,   0,   0,   0, 200, 200,   0, '药品包',        '医疗用品',     NULL,             NULL,             NULL),
  ('生化医疗系统',     'jp', 3, 200,   0,   0,   0, 100, 300, '医疗用品',      '医疗设备',     '工业能源核心',   NULL,             NULL),
  ('疫苗研发核心',     'jp', 3,   0,   0,   0, 200, 300, 100, '防护装备',      '实验仪器',     '智能监控系统',   NULL,             NULL),
  ('医疗AI诊断系统',   'jp', 3,   0, 200,   0,   0, 200, 200, '药品包',        '紧急救援系统', '战略无人机',     NULL,             NULL),
  ('全球医疗网络',     'jp', 4, 300,   0,   0,   0, 200, 400, '医疗AI诊断系统','疫苗研发核心', '太空卫星网络',   'AI核心系统',     NULL),
  ('高级医疗产品',     'jp', 4, 200,   0,   0,   0, 300, 400, '生化医疗系统',  '疫苗研发核心', '永续能源模组',   '太空科技',       NULL),

  -- ===== USA =====
  ('金融软件',         'us', 1,   0,   0,   0,   0, 100, 100, NULL,            NULL,           NULL,             NULL,             NULL),
  ('投资系统',         'us', 1,   0,   0,   0, 100,   0, 100, NULL,            NULL,           NULL,             NULL,             NULL),
  ('商业网络系统',     'us', 1,   0,   0,   0, 100, 100,   0, NULL,            NULL,           NULL,             NULL,             NULL),
  ('国防系统',         'us', 2,   0,   0,   0, 300,   0, 100, '商业网络系统',  NULL,           NULL,             NULL,             NULL),
  ('战略无人机',       'us', 2,   0,   0,   0, 200,   0, 300, '金融软件',      NULL,           NULL,             NULL,             NULL),
  ('国家安全AI',       'us', 2,   0,   0,   0,   0, 200, 200, '商业网络系统',  '投资系统',     NULL,             NULL,             NULL),
  ('太空科技',         'us', 3,   0,   0,   0, 200, 200, 200, '投资系统',      '战略无人机',   '紧急救援系统',   NULL,             NULL),
  ('宇航系统',         'us', 3,   0,   0,   0,   0, 300, 300, '金融软件',      '国家安全AI',   '工业能源核心',   NULL,             NULL),
  ('太空卫星网络',     'us', 3,   0,   0,   0, 400,   0, 200, '商业网络系统',  '国防系统',     'AI电脑',         NULL,             NULL),
  ('全球金融AI系统',   'us', 4,   0,   0,   0, 500, 300, 100, '太空卫星网络',  '太空科技',     '永续能源模组',   '医疗AI诊断系统', NULL),
  ('世界防御网络',     'us', 4,   0,   0,   0, 100, 500, 300, '太空卫星网络',  '宇航系统',     '太阳能核心',     '智能机器人',     NULL);

-- ============================================================================
-- prices (computed from buildDefaultPrices_ in apps-script.gs)
--   resources:  price=500, price_jp=450 (-10%), sell=300, asset_value=0
--   L1:         price=1000, sell=600 (KR L1 sell=660, +10% manufacturing bonus), asset_value=1000
--   L2:         price=3000, sell=1800, asset_value=3000
--   L3:         price=8000, sell=4800, asset_value=8000 (sold to bank only; "估值")
--   L4:         price=20000, sell=12000, asset_value=20000 ("估值")
-- ============================================================================
INSERT OR REPLACE INTO prices (item_type, item_key, unit_size, price, price_jp, sell_price, asset_value, note) VALUES
  -- resources
  ('resource', 'water',       100,   500,  450,   300,    0, '水'),
  ('resource', 'oil',         100,   500,  450,   300,    0, '石油'),
  ('resource', 'wood',        100,   500,  450,   300,    0, '木材'),
  ('resource', 'metal',       100,   500,  450,   300,    0, '金属'),
  ('resource', 'electricity', 100,   500,  450,   300,    0, '电力'),
  ('resource', 'chips',       100,   500,  450,   300,    0, '晶片'),

  -- MY products
  ('l1', '石油燃料包',       1,  1000, NULL,   600,  1000, 'MY L1'),
  ('l1', '木材资源包',       1,  1000, NULL,   600,  1000, 'MY L1'),
  ('l1', '基础发电机',       1,  1000, NULL,   600,  1000, 'MY L1'),
  ('l2', '工业能源核心',     1,  3000, NULL,  1800,  3000, 'MY L2'),
  ('l2', '港口运输系统',     1,  3000, NULL,  1800,  3000, 'MY L2'),
  ('l2', '工业燃料系统',     1,  3000, NULL,  1800,  3000, 'MY L2'),
  ('l3', '太阳能核心',       1,  8000, NULL,  4800,  8000, 'MY L3 · 估值'),
  ('l3', '水力能源系统',     1,  8000, NULL,  4800,  8000, 'MY L3 · 估值'),
  ('l3', '永续能源模组',     1,  8000, NULL,  4800,  8000, 'MY L3 · 估值'),
  ('l4', '国家能源网络',     1, 20000, NULL, 12000, 20000, 'MY L4'),
  ('l4', '全球能源供应系统', 1, 20000, NULL, 12000, 20000, 'MY L4'),

  -- KR products (L1 gets +10% sell bonus = 660)
  ('l1', '手机零件',         1,  1000, NULL,   660,  1000, 'KR L1 · KR +10% 制造溢价'),
  ('l1', '基础电脑系统',     1,  1000, NULL,   660,  1000, 'KR L1 · KR +10% 制造溢价'),
  ('l1', '电竞设备',         1,  1000, NULL,   660,  1000, 'KR L1 · KR +10% 制造溢价'),
  ('l2', 'AI电脑',           1,  3000, NULL,  1800,  3000, 'KR L2'),
  ('l2', '智能监控系统',     1,  3000, NULL,  1800,  3000, 'KR L2'),
  ('l2', '云端AI服务器',     1,  3000, NULL,  1800,  3000, 'KR L2'),
  ('l3', '智能机器人',       1,  8000, NULL,  4800,  8000, 'KR L3 · 估值'),
  ('l3', '自动驾驶系统',     1,  8000, NULL,  4800,  8000, 'KR L3 · 估值'),
  ('l3', 'AI核心系统',       1,  8000, NULL,  4800,  8000, 'KR L3 · 估值'),
  ('l4', '卫星科技系统',     1, 20000, NULL, 12000, 20000, 'KR L4'),
  ('l4', '火箭控制系统',     1, 20000, NULL, 12000, 20000, 'KR L4'),

  -- JP products
  ('l1', '医疗用品',         1,  1000, NULL,   600,  1000, 'JP L1'),
  ('l1', '药品包',           1,  1000, NULL,   600,  1000, 'JP L1'),
  ('l1', '防护装备',         1,  1000, NULL,   600,  1000, 'JP L1'),
  ('l2', '医疗设备',         1,  3000, NULL,  1800,  3000, 'JP L2'),
  ('l2', '实验仪器',         1,  3000, NULL,  1800,  3000, 'JP L2'),
  ('l2', '紧急救援系统',     1,  3000, NULL,  1800,  3000, 'JP L2'),
  ('l3', '生化医疗系统',     1,  8000, NULL,  4800,  8000, 'JP L3 · 估值'),
  ('l3', '疫苗研发核心',     1,  8000, NULL,  4800,  8000, 'JP L3 · 估值'),
  ('l3', '医疗AI诊断系统',   1,  8000, NULL,  4800,  8000, 'JP L3 · 估值'),
  ('l4', '全球医疗网络',     1, 20000, NULL, 12000, 20000, 'JP L4'),
  ('l4', '高级医疗产品',     1, 20000, NULL, 12000, 20000, 'JP L4'),

  -- US products
  ('l1', '金融软件',         1,  1000, NULL,   600,  1000, 'US L1'),
  ('l1', '投资系统',         1,  1000, NULL,   600,  1000, 'US L1'),
  ('l1', '商业网络系统',     1,  1000, NULL,   600,  1000, 'US L1'),
  ('l2', '国防系统',         1,  3000, NULL,  1800,  3000, 'US L2'),
  ('l2', '战略无人机',       1,  3000, NULL,  1800,  3000, 'US L2'),
  ('l2', '国家安全AI',       1,  3000, NULL,  1800,  3000, 'US L2'),
  ('l3', '太空科技',         1,  8000, NULL,  4800,  8000, 'US L3 · 估值'),
  ('l3', '宇航系统',         1,  8000, NULL,  4800,  8000, 'US L3 · 估值'),
  ('l3', '太空卫星网络',     1,  8000, NULL,  4800,  8000, 'US L3 · 估值'),
  ('l4', '全球金融AI系统',   1, 20000, NULL, 12000, 20000, 'US L4'),
  ('l4', '世界防御网络',     1, 20000, NULL, 12000, 20000, 'US L4');
