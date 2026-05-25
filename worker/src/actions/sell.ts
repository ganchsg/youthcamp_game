import type { Env } from '../types';
import { err, ok, getCountry, getPriceInfo, addProduct, writeLog } from '../util';

export interface SellBody {
  country_id?: string;
  item_type?: string;       // 'l1' | 'l2' | 'l3' | 'l4'
  item_key?: string;
  qty?: string | number;
  to?: string;              // 'bank' or buyer country_id
  price?: string | number | null;
  dice?: string | number | null;
  use_nofail?: string | boolean;
  reason?: string;
  mentor?: string;
}

const LVL_MAP: Record<string, number> = { l1: 1, l2: 2, l3: 3, l4: 4 };

export async function sell(env: Env, b: SellBody): Promise<Response> {
  const seller_id = b.country_id;
  const item_type = b.item_type;
  const item_key = b.item_key;
  const qty = Number(b.qty);
  const to = (b.to ?? '').toString().trim();
  const negotiated = (b.price != null && b.price !== '') ? Number(b.price) : null;
  const dice = (b.dice != null && b.dice !== '') ? Number(b.dice) : NaN;
  const useNofail = b.use_nofail === true || b.use_nofail === '1' || b.use_nofail === 'true';
  const mentor = (b.mentor ?? '').toString().trim();
  const reason = (b.reason ?? '').toString().trim();

  if (!seller_id) return err('missing seller country_id');
  if (!item_type || !item_key) return err('missing item');
  if (!['l1','l2','l3','l4'].includes(item_type)) return err('只能销售 L1/L2/L3/L4 产品，不能售卖资源');
  if (!Number.isFinite(qty) || qty <= 0) return err('qty 必须为正数');
  if (!to) return err('必须选择销售对象 (银行或国家)');
  if (to === seller_id) return err('不能卖给自己');
  if (!mentor) return err('必须先选择导师身份');
  if (!reason) return err('必须填写销售原因');
  if (item_type === 'l4' && to !== 'bank') {
    return err('L4 产品不能跨国销售 — L4 只能本国生产,只能卖给 🏦 银行');
  }
  if (!useNofail) {
    if (!Number.isFinite(dice) || dice < 1 || dice > 6) {
      return err('运输必须输入骰子结果 (1-6); 4=运输失败');
    }
  }
  const shipSuccess = useNofail ? true : (dice !== 4);

  // Unit price
  let unitPrice: number;
  if (to === 'bank') {
    const pi = await getPriceInfo(env, item_type, item_key);
    if (!pi) return err('价格表中找不到: ' + item_key);
    unitPrice = pi.sell_price;
    if (!unitPrice || unitPrice <= 0) return err(`${item_key} 的售卖价为 0，无法卖给银行`);
  } else {
    if (negotiated == null || !Number.isFinite(negotiated) || negotiated < 0) {
      return err('国家间交易必须填写协商单价');
    }
    unitPrice = negotiated;
  }
  const totalCoins = qty * unitPrice;

  // Fetch seller (and buyer if country)
  const seller = await getCountry(env, seller_id);
  if (!seller) return err('卖方国家不存在: ' + seller_id);
  const buyer = to !== 'bank' ? await getCountry(env, to) : null;
  if (to !== 'bank' && !buyer) return err('买方国家不存在: ' + to);

  // Check seller has enough product
  const prodRow = await env.DB
    .prepare('SELECT qty FROM products WHERE country_id = ? AND name = ?')
    .bind(seller_id, item_key).first<{ qty: number }>();
  const sellerHave = prodRow ? Number(prodRow.qty) || 0 : 0;
  if (sellerHave < qty) return err(`库存不足: ${item_key} 当前 ${sellerHave}，需 ${qty}`);

  // Check no-fail card
  if (useNofail && (Number(seller.no_fail_cards) || 0) < 1) {
    return err('没有免失败运输卡可用');
  }

  // If shipping succeeds AND selling to country, check buyer's coins
  if (shipSuccess && buyer && (Number(buyer.coins) || 0) < totalCoins) {
    return err(`买方金币不足: ${to.toUpperCase()} 当前 ${buyer.coins}，需 ${totalCoins}`);
  }

  // ===== APPLY =====
  const changes: string[] = [];

  // 1) Seller's product -= qty (always)
  const sellerProdBefore = sellerHave;
  const sellerProdAfter = sellerHave - qty;
  await env.DB
    .prepare('UPDATE products SET qty = ? WHERE country_id = ? AND name = ?')
    .bind(sellerProdAfter, seller_id, item_key).run();
  changes.push(`${seller_id}:${item_key}: ${sellerProdBefore}→${sellerProdAfter}`);

  // 2) Consume no-fail card if used (always — once committed)
  if (useNofail) {
    const before = Number(seller.no_fail_cards) || 0;
    const after = before - 1;
    await env.DB
      .prepare('UPDATE countries SET no_fail_cards = ? WHERE country_id = ?')
      .bind(after, seller_id).run();
    changes.push(`${seller_id}:no_fail_cards: ${before}→${after}`);
  }

  const sellerCoinsBefore = Number(seller.coins) || 0;
  let sellerCoinsAfter = sellerCoinsBefore;

  if (shipSuccess) {
    // 3) Seller's coins += totalCoins
    sellerCoinsAfter = sellerCoinsBefore + totalCoins;
    await env.DB
      .prepare('UPDATE countries SET coins = ? WHERE country_id = ?')
      .bind(sellerCoinsAfter, seller_id).run();
    changes.push(`${seller_id}:coins: ${sellerCoinsBefore}→${sellerCoinsAfter}`);

    // 4) +1 shipments
    const shipBefore = Number(seller.shipments) || 0;
    const shipAfter = shipBefore + 1;
    await env.DB
      .prepare('UPDATE countries SET shipments = ? WHERE country_id = ?')
      .bind(shipAfter, seller_id).run();
    changes.push(`${seller_id}:shipments: ${shipBefore}→${shipAfter}`);

    // 5) Buyer country: -coins, +product
    if (buyer) {
      const bcBefore = Number(buyer.coins) || 0;
      const bcAfter = bcBefore - totalCoins;
      await env.DB
        .prepare('UPDATE countries SET coins = ? WHERE country_id = ?')
        .bind(bcAfter, to).run();
      changes.push(`${to}:coins: ${bcBefore}→${bcAfter}`);

      const lvl = LVL_MAP[item_type];
      const pc = await addProduct(env, to, lvl, item_key, qty);
      changes.push(`${to}:${item_key}: ${pc.before}→${pc.after}`);
    }
  }

  // Log (seller side, then buyer mirror on success)
  const dest = to === 'bank' ? '🏦 银行' : to.toUpperCase();
  const tag = shipSuccess ? '💸 运输成功' : '✗ 运输失败';
  const diceStr = useNofail ? '🎫免失败卡' : `🎲${dice}`;
  const event = shipSuccess ? 'sell' : 'sell_fail';
  const detail = shipSuccess
    ? `${tag} ${item_key} ×${qty} → ${dest} | ${diceStr} | 单价 ${unitPrice}, 共 ${totalCoins} 金币 | ${changes.join(', ')}`
    : `${tag} ${item_key} ×${qty} → ${dest} | ${diceStr} | 产品损失 | ${changes.join(', ')}`;
  await writeLog(env, mentor, seller_id, event, item_key,
                 shipSuccess ? totalCoins : 0, sellerCoinsBefore, sellerCoinsAfter, detail, reason);
  if (shipSuccess && to !== 'bank') {
    const buyerDetail = `💵 收购 ${item_key} ×${qty} ← ${seller_id.toUpperCase()} (单价 ${unitPrice}, 共 ${totalCoins} 金币)`;
    await writeLog(env, mentor, to, 'sell', item_key, -totalCoins, null, null, buyerDetail, reason);
  }

  return ok({
    ship_success: shipSuccess,
    dice: Number.isFinite(dice) ? dice : null,
    nofail_used: useNofail,
    seller: seller_id,
    buyer: to,
    item_key,
    qty,
    unit_price: unitPrice,
    total_coins: shipSuccess ? totalCoins : 0,
    seller_new_coins: sellerCoinsAfter,
  });
}
