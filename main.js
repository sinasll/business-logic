/**
 * Store API Function — single function for all writes / business logic.
 *
 * Actions (POST JSON with { action, initData, payload }):
 *  - bootstrap_user          : verify Telegram initData, upsert user, return profile
 *  - submit_order            : create pending order, validate discounts, notify admins
 *  - submit_vip              : create pending VIP membership, notify admins
 *  - spin_wheel              : consume 1 ticket, weighted-random prize
 *  - admin_decide_order      : approve/reject order (admin only) -> awards points, ticket, weekly pts, marks VIP if applicable
 *  - admin_decide_vip        : approve/reject VIP membership
 *  - admin_grant_vip         : manually grant VIP
 *  - admin_update_user       : edit points / ban / unban
 *  - admin_save_product      : create/update product
 *  - admin_delete_product
 *  - admin_save_category
 *  - admin_delete_category
 *  - admin_save_discount
 *  - admin_delete_discount
 *  - admin_save_prize
 *  - admin_delete_prize
 *  - admin_save_setting
 *  - validate_discount       : check a code and compute final price (no DB write)
 */
const sdk = require('node-appwrite');
const crypto = require('crypto');

const DB = process.env.APPWRITE_DATABASE_ID || 'store';
const BUCKET = process.env.APPWRITE_BUCKET_ID || 'store';
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const VIP_PLANS = {
  monthly: { price: 5000, days: 30 },
  annual:  { price: 25000, days: 365 },
  lifetime:{ price: 80000, days: 0 },
};

const LOYALTY_TIERS = [
  { name: 'Bronze',  min: 0,  max: 5,   discount: 5  },
  { name: 'Silver',  min: 5,  max: 15,  discount: 10 },
  { name: 'Gold',    min: 15, max: 50,  discount: 15 },
  { name: 'Diamond', min: 50, max: Infinity, discount: 20 },
];

function tierFor(points) {
  return LOYALTY_TIERS.find(t => points >= t.min && points < t.max) || LOYALTY_TIERS[0];
}

// ---- Telegram initData verification ----
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch { return null; }
}

async function notifyAdmins(text) {
  if (!BOT_TOKEN || ADMIN_IDS.length === 0) return;
  for (const id of ADMIN_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' }),
      });
    } catch {}
  }
}

function isAdmin(tgUser) {
  return tgUser && ADMIN_IDS.includes(String(tgUser.id));
}

function nowISO() { return new Date().toISOString(); }

module.exports = async ({ req, res, log, error }) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action, initData, payload = {} } = body;

    // Dev fallback: if BOT_TOKEN not set, allow passing user directly (NOT for production).
    let tgUser = verifyInitData(initData, BOT_TOKEN);
    if (!tgUser && !BOT_TOKEN && payload.devUser) tgUser = payload.devUser;
    if (!tgUser) return res.json({ ok: false, error: 'unauthorized' }, 401);

    const client = new sdk.Client()
      .setEndpoint(req.headers['x-appwrite-endpoint'] || process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1')
      .setProject(req.headers['x-appwrite-project'] || process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '');
    const db = new sdk.Databases(client);

    // ---- bootstrap user ----
    if (action === 'bootstrap_user') {
      const tid = String(tgUser.id);
      let user;
      try {
        const found = await db.listDocuments(DB, 'users', [sdk.Query.equal('telegramId', tid), sdk.Query.limit(1)]);
        if (found.documents[0]) {
          user = found.documents[0];
          // light update of display fields
          user = await db.updateDocument(DB, 'users', user.$id, {
            username: tgUser.username || user.username,
            firstName: tgUser.first_name || user.firstName,
            lastName: tgUser.last_name || user.lastName,
            photoUrl: tgUser.photo_url || user.photoUrl,
            languageCode: tgUser.language_code || user.languageCode,
            isPremium: !!tgUser.is_premium,
          });
        } else {
          user = await db.createDocument(DB, 'users', sdk.ID.unique(), {
            telegramId: tid,
            username: tgUser.username || '',
            firstName: tgUser.first_name || '',
            lastName: tgUser.last_name || '',
            photoUrl: tgUser.photo_url || '',
            languageCode: tgUser.language_code || 'en',
            isPremium: !!tgUser.is_premium,
            phone: '',
            loyaltyPoints: 0, totalSpent: 0, totalOrders: 0, wheelTickets: 0, weeklyPoints: 0,
            vipStatus: 'none', vipExpiry: '', banned: false, createdAt: nowISO(),
          });
        }
      } catch (e) { error(e.message); return res.json({ ok: false, error: 'user_init_failed' }, 500); }
      return res.json({ ok: true, user, isAdmin: isAdmin(tgUser) });
    }

    // Find user doc
    const userList = await db.listDocuments(DB, 'users', [sdk.Query.equal('telegramId', String(tgUser.id)), sdk.Query.limit(1)]);
    const userDoc = userList.documents[0];
    if (!userDoc) return res.json({ ok: false, error: 'no_user' }, 400);
    if (userDoc.banned) return res.json({ ok: false, error: 'banned' }, 403);

    // ---- validate_discount (no writes) ----
    if (action === 'validate_discount') {
      const { productId, code } = payload;
      const product = await db.getDocument(DB, 'products', productId);
      const result = await computeFinalPrice(db, product, userDoc, code);
      return res.json({ ok: true, ...result });
    }

    // ---- submit_order ----
    if (action === 'submit_order') {
      const { productId, paymentMethod, screenshotFileId, discountCode, phone } = payload;
      if (!productId || !paymentMethod || !screenshotFileId) return res.json({ ok: false, error: 'missing_fields' }, 400);
      const product = await db.getDocument(DB, 'products', productId);
      if (product.status !== 'available' || product.stock <= 0) return res.json({ ok: false, error: 'unavailable' }, 400);
      const priced = await computeFinalPrice(db, product, userDoc, discountCode);

      const order = await db.createDocument(DB, 'orders', sdk.ID.unique(), {
        userId: userDoc.$id,
        telegramId: userDoc.telegramId,
        username: userDoc.username,
        firstName: userDoc.firstName,
        lastName: userDoc.lastName,
        phone: phone || userDoc.phone || '',
        productId: product.$id,
        productName: product.name,
        originalPrice: product.price,
        finalPrice: priced.finalPrice,
        discountsApplied: JSON.stringify(priced.applied),
        paymentMethod,
        screenshotFileId,
        status: 'pending',
        createdAt: nowISO(),
        type: 'product',
      });
      if (phone && phone !== userDoc.phone) {
        await db.updateDocument(DB, 'users', userDoc.$id, { phone });
      }

      const txt = `<b>NEW ORDER</b>\nProduct: ${product.name}\nCustomer: ${userDoc.firstName} ${userDoc.lastName} (@${userDoc.username})\nTelegram ID: ${userDoc.telegramId}\nPhone: ${phone || '-'}\nMethod: ${paymentMethod}\nOriginal: ${product.price} IQD\nFinal: ${priced.finalPrice} IQD\nDiscounts: ${priced.applied.map(a=>a.label).join(', ') || 'none'}\nTime: ${nowISO()}`;
      await notifyAdmins(txt);
      return res.json({ ok: true, order });
    }

    // ---- submit_vip ----
    if (action === 'submit_vip') {
      const { planType, paymentMethod, screenshotFileId } = payload;
      const plan = VIP_PLANS[planType];
      if (!plan || !paymentMethod || !screenshotFileId) return res.json({ ok: false, error: 'missing_fields' }, 400);
      const vip = await db.createDocument(DB, 'vipMembers', sdk.ID.unique(), {
        userId: userDoc.$id,
        telegramId: userDoc.telegramId,
        planType,
        price: plan.price,
        status: 'pending',
        paymentMethod,
        screenshotFileId,
        createdAt: nowISO(),
      });
      // Also create an order record for unified review
      const order = await db.createDocument(DB, 'orders', sdk.ID.unique(), {
        userId: userDoc.$id, telegramId: userDoc.telegramId,
        username: userDoc.username, firstName: userDoc.firstName, lastName: userDoc.lastName, phone: userDoc.phone || '',
        productId: vip.$id, productName: `VIP ${planType}`,
        originalPrice: plan.price, finalPrice: plan.price, discountsApplied: '[]',
        paymentMethod, screenshotFileId, status: 'pending', createdAt: nowISO(), type: 'vip',
      });
      await notifyAdmins(`<b>NEW VIP APPLICATION</b>\nPlan: ${planType}\nUser: ${userDoc.firstName} (@${userDoc.username})\nID: ${userDoc.telegramId}\nPrice: ${plan.price} IQD\nMethod: ${paymentMethod}`);
      return res.json({ ok: true, vip, order });
    }

    // ---- spin_wheel ----
    if (action === 'spin_wheel') {
      if ((userDoc.wheelTickets || 0) <= 0) return res.json({ ok: false, error: 'no_tickets' }, 400);
      const prizesList = await db.listDocuments(DB, 'wheelPrizes', [sdk.Query.equal('active', true), sdk.Query.limit(50)]);
      const prizes = prizesList.documents;
      if (!prizes.length) return res.json({ ok: false, error: 'no_prizes' }, 400);
      const totalWeight = prizes.reduce((s, p) => s + (p.weight || 1), 0);
      let r = Math.random() * totalWeight;
      let won = prizes[0];
      for (const p of prizes) { r -= (p.weight || 1); if (r <= 0) { won = p; break; } }
      await db.updateDocument(DB, 'users', userDoc.$id, { wheelTickets: userDoc.wheelTickets - 1 });
      const spin = await db.createDocument(DB, 'wheelSpins', sdk.ID.unique(), {
        userId: userDoc.$id, telegramId: userDoc.telegramId,
        prizeId: won.$id, prizeLabel: won.label, createdAt: nowISO(),
      });
      return res.json({ ok: true, prize: won, spin });
    }

    // ============ ADMIN ACTIONS ============
    if (!isAdmin(tgUser)) return res.json({ ok: false, error: 'forbidden' }, 403);

    if (action === 'admin_decide_order') {
      const { orderId, decision, adminNotes } = payload;
      const order = await db.getDocument(DB, 'orders', orderId);
      if (order.status !== 'pending') return res.json({ ok: false, error: 'already_decided' }, 400);
      const updates = { status: decision, decidedAt: nowISO(), decidedBy: String(tgUser.id), adminNotes: adminNotes || '' };
      await db.updateDocument(DB, 'orders', orderId, updates);

      if (decision === 'approved') {
        const target = await db.getDocument(DB, 'users', order.userId);
        const isVIPOrder = order.type === 'vip';
        const vipBonus = target.vipStatus === 'active' ? 1 : 0;

        const userUpdates = {
          totalSpent: (target.totalSpent || 0) + order.finalPrice,
          totalOrders: (target.totalOrders || 0) + 1,
          wheelTickets: (target.wheelTickets || 0) + 1 + vipBonus,
          weeklyPoints: (target.weeklyPoints || 0) + 1 + vipBonus,
        };
        if (order.finalPrice >= 10000) {
          userUpdates.loyaltyPoints = (target.loyaltyPoints || 0) + 1 + vipBonus;
        }
        if (isVIPOrder) {
          const plan = VIP_PLANS[order.productName.replace('VIP ', '')];
          if (plan) {
            const start = new Date();
            const expiry = plan.days === 0 ? '' : new Date(start.getTime() + plan.days * 86400000).toISOString();
            userUpdates.vipStatus = 'active';
            userUpdates.vipExpiry = expiry;
            // mark vip doc
            const vipList = await db.listDocuments(DB, 'vipMembers', [sdk.Query.equal('userId', target.$id), sdk.Query.equal('status', 'pending'), sdk.Query.limit(1)]);
            if (vipList.documents[0]) {
              await db.updateDocument(DB, 'vipMembers', vipList.documents[0].$id, {
                status: 'active', startDate: start.toISOString(), expiryDate: expiry, approvedBy: String(tgUser.id), approvedAt: nowISO(),
              });
            }
          }
        } else {
          // decrement stock
          try {
            const prod = await db.getDocument(DB, 'products', order.productId);
            await db.updateDocument(DB, 'products', order.productId, { stock: Math.max(0, prod.stock - 1) });
          } catch {}
        }
        await db.updateDocument(DB, 'users', target.$id, userUpdates);
      } else if (decision === 'rejected' && order.type === 'vip') {
        const vipList = await db.listDocuments(DB, 'vipMembers', [sdk.Query.equal('userId', order.userId), sdk.Query.equal('status', 'pending'), sdk.Query.limit(1)]);
        if (vipList.documents[0]) await db.updateDocument(DB, 'vipMembers', vipList.documents[0].$id, { status: 'rejected' });
      }

      // notify user
      if (BOT_TOKEN) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ chat_id: order.telegramId, text: decision === 'approved' ? `Your order "${order.productName}" was APPROVED. Thank you!` : `Your order "${order.productName}" was rejected. ${adminNotes||''}` }),
          });
        } catch {}
      }
      return res.json({ ok: true });
    }

    if (action === 'admin_grant_vip') {
      const { targetUserId, planType } = payload;
      const plan = VIP_PLANS[planType]; if (!plan) return res.json({ ok:false, error:'bad_plan' }, 400);
      const start = new Date();
      const expiry = plan.days === 0 ? '' : new Date(start.getTime() + plan.days*86400000).toISOString();
      await db.updateDocument(DB, 'users', targetUserId, { vipStatus: 'active', vipExpiry: expiry });
      await db.createDocument(DB, 'vipMembers', sdk.ID.unique(), {
        userId: targetUserId, telegramId: '', planType, price: 0, status: 'active',
        startDate: start.toISOString(), expiryDate: expiry, paymentMethod: 'manual',
        approvedBy: String(tgUser.id), approvedAt: nowISO(), createdAt: nowISO(),
      });
      return res.json({ ok: true });
    }

    if (action === 'admin_update_user') {
      const { targetUserId, updates } = payload;
      await db.updateDocument(DB, 'users', targetUserId, updates);
      return res.json({ ok: true });
    }

    if (action === 'admin_save_product') {
      const { id, data } = payload;
      data.updatedAt = nowISO();
      if (id) { await db.updateDocument(DB, 'products', id, data); return res.json({ ok: true, id }); }
      data.createdAt = nowISO();
      const doc = await db.createDocument(DB, 'products', sdk.ID.unique(), data);
      return res.json({ ok: true, id: doc.$id });
    }
    if (action === 'admin_delete_product') { await db.deleteDocument(DB, 'products', payload.id); return res.json({ ok: true }); }

    if (action === 'admin_save_category') {
      const { id, data } = payload;
      if (id) { await db.updateDocument(DB, 'categories', id, data); return res.json({ ok: true, id }); }
      const doc = await db.createDocument(DB, 'categories', sdk.ID.unique(), data);
      return res.json({ ok: true, id: doc.$id });
    }
    if (action === 'admin_delete_category') { await db.deleteDocument(DB, 'categories', payload.id); return res.json({ ok: true }); }

    if (action === 'admin_save_discount') {
      const { id, data } = payload;
      if (id) { await db.updateDocument(DB, 'discountCodes', id, data); return res.json({ ok: true, id }); }
      const doc = await db.createDocument(DB, 'discountCodes', sdk.ID.unique(), data);
      return res.json({ ok: true, id: doc.$id });
    }
    if (action === 'admin_delete_discount') { await db.deleteDocument(DB, 'discountCodes', payload.id); return res.json({ ok: true }); }

    if (action === 'admin_save_prize') {
      const { id, data } = payload;
      if (id) { await db.updateDocument(DB, 'wheelPrizes', id, data); return res.json({ ok: true, id }); }
      const doc = await db.createDocument(DB, 'wheelPrizes', sdk.ID.unique(), data);
      return res.json({ ok: true, id: doc.$id });
    }
    if (action === 'admin_delete_prize') { await db.deleteDocument(DB, 'wheelPrizes', payload.id); return res.json({ ok: true }); }

    if (action === 'admin_save_setting') {
      const { key, value } = payload;
      const found = await db.listDocuments(DB, 'settings', [sdk.Query.equal('key', key), sdk.Query.limit(1)]);
      if (found.documents[0]) await db.updateDocument(DB, 'settings', found.documents[0].$id, { value });
      else await db.createDocument(DB, 'settings', sdk.ID.unique(), { key, value });
      return res.json({ ok: true });
    }

    return res.json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    error(e.message);
    return res.json({ ok: false, error: e.message }, 500);
  }
};

async function computeFinalPrice(db, product, userDoc, code) {
  const applied = [];
  let price = product.salePrice && product.salePrice > 0 ? product.salePrice : product.price;
  if (product.salePrice && product.salePrice > 0 && product.salePrice < product.price) {
    applied.push({ label: `Sale -${product.price - product.salePrice} IQD`, amount: product.price - product.salePrice });
  }
  // Product automatic discount
  if (product.hasAutomaticDiscount && product.discountEnabled && product.discountValue > 0) {
    if (product.discountType === 'percentage') {
      const d = Math.floor(price * product.discountValue / 100);
      price -= d; applied.push({ label: `Auto -${product.discountValue}%`, amount: d });
    } else if (product.discountType === 'fixed') {
      price = Math.max(0, price - product.discountValue);
      applied.push({ label: `Auto -${product.discountValue} IQD`, amount: product.discountValue });
    }
  }
  // Category discount
  try {
    const cat = await db.getDocument(DB, 'categories', product.categoryId);
    if (cat.discountPct > 0) {
      const d = Math.floor(price * cat.discountPct / 100);
      price -= d; applied.push({ label: `${cat.name} -${cat.discountPct}%`, amount: d });
    }
  } catch {}
  // Loyalty discount (always applies)
  const tier = tierFor(userDoc.loyaltyPoints || 0);
  const lDisc = Math.floor(price * tier.discount / 100);
  price -= lDisc; applied.push({ label: `${tier.name} -${tier.discount}%`, amount: lDisc });
  // VIP discount
  if (userDoc.vipStatus === 'active') {
    const v = Math.floor(price * 15 / 100);
    price -= v; applied.push({ label: `VIP -15%`, amount: v });
  }
  // Discount code
  if (code) {
    try {
      const found = await db.listDocuments(DB, 'discountCodes', [sdk.Query.equal('code', code.toUpperCase()), sdk.Query.limit(1)]);
      const dc = found.documents[0];
      if (dc && dc.active) {
        const ok = (!dc.expiryDate || new Date(dc.expiryDate) > new Date())
          && (!dc.usageLimit || dc.usedCount < dc.usageLimit)
          && (!dc.minimumPurchaseAmount || product.price >= dc.minimumPurchaseAmount)
          && (dc.global || (dc.productIds||'').includes(product.$id) || (dc.categoryIds||'').includes(product.categoryId));
        if (ok) {
          let d = dc.type === 'percentage' ? Math.floor(price * dc.value / 100) : dc.value;
          d = Math.min(d, price);
          price -= d; applied.push({ label: `${dc.code} -${d} IQD`, amount: d, codeId: dc.$id });
          await db.updateDocument(DB, 'discountCodes', dc.$id, { usedCount: dc.usedCount + 1 });
        }
      }
    } catch {}
  }
  return { finalPrice: Math.max(0, price), applied };
}
