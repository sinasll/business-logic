/**
 * Store - Business Logic Function (Appwrite Function)
 * Handles: purchase submission, VIP submission, discount calculation,
 * wheel spin logic, loyalty/leaderboard updates, VIP calculations.
 */

import { Client, Databases, Storage, Query } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Appwrite-Project'
};

const CONFIG = {
  DATABASE_ID: 'store_db',
  BUCKETS: { PRODUCTS: 'product_images', PAYMENTS: 'payment_screenshots', VIP: 'vip_screenshots' },
  COLLECTIONS: {
    USERS: 'users', PRODUCTS: 'products', ORDERS: 'orders', VIP_PURCHASES: 'vip_purchases',
    VIP_MEMBERS: 'vip_members', LEADERBOARD: 'leaderboard', WHEEL_PRIZES: 'wheel_prizes',
    WHEEL_SPINS: 'wheel_spins', DISCOUNT_CODES: 'discount_codes', PRODUCT_DISCOUNTS: 'product_discounts'
  },
  VIP_PLANS: {
    monthly: { id: 'monthly', label: 'Monthly', price: 5000, durationDays: 30 },
    annual: { id: 'annual', label: 'Annual', price: 25000, durationDays: 365 },
    lifetime: { id: 'lifetime', label: 'Lifetime', price: 80000, durationDays: null }
  },
  LOYALTY_TIERS: [
    { id: 'bronze', label: 'Bronze', min: 0, discount: 5 },
    { id: 'silver', label: 'Silver', min: 5, discount: 10 },
    { id: 'gold', label: 'Gold', min: 15, discount: 15 },
    { id: 'diamond', label: 'Diamond', min: 50, discount: 20 }
  ]
};

function getTier(points) {
  return CONFIG.LOYALTY_TIERS.slice().reverse().find(t => points >= t.min) || CONFIG.LOYALTY_TIERS[0];
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function isExpired(iso) { return iso ? new Date() > new Date(iso) : false; }

function formatCurrency(value) { return `${Number(value || 0).toLocaleString()} IQD`; }

function uid(prefix = '') { return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 8); }

function weightedRandom(items) {
  const total = items.reduce((sum, i) => sum + (i.weight || 0), 0);
  let r = Math.random() * total;
  for (const item of items) { r -= (item.weight || 0); if (r <= 0) return item; }
  return items[items.length - 1];
}

function respond(res, status, data) {
  return res.json({ ...corsHeaders, statusCode: status, body: data }, status);
}

export default async function (context) {
  const { req, res, log, error } = context;

  if (req.method === 'OPTIONS') {
    return res.text('', 204, corsHeaders);
  }

  if (req.method !== 'POST') {
    return res.json({ ...corsHeaders, statusCode: 405, body: { error: 'Method not allowed' } }, 405);
  }

  let payload = {};
  try {
    payload = JSON.parse(req.bodyRaw || '{}');
  } catch (err) {
    return res.json({ ...corsHeaders, statusCode: 400, body: { error: 'Invalid JSON' } }, 400);
  }

  const client = new Client();
  client.setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1').setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID);

  // If API key is available, use it for full server access; otherwise rely on permissions.
  if (process.env.APPWRITE_API_KEY) client.setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const storage = new Storage(client);
  const { action } = payload;

  try {
    switch (action) {
      case 'calculatePrice': {
        const result = await calculatePrice(databases, payload);
        return respond(res, 200, result);
      }
      case 'validateDiscountCode': {
        const result = await validateDiscountCode(databases, payload);
        return respond(res, 200, result);
      }
      case 'submitOrder': {
        const order = await submitOrder(databases, storage, payload);
        return respond(res, 200, { order });
      }
      case 'submitVip': {
        const purchase = await submitVip(databases, storage, payload);
        return respond(res, 200, { purchase });
      }
      case 'spinWheel': {
        const result = await spinWheel(databases, payload);
        return respond(res, 200, result);
      }
      case 'approveOrder': {
        await approveOrder(databases, payload);
        return respond(res, 200, { success: true });
      }
      case 'rejectOrder': {
        await rejectOrder(databases, payload);
        return respond(res, 200, { success: true });
      }
      case 'activateVip': {
        await activateVip(databases, payload);
        return respond(res, 200, { success: true });
      }
      case 'rejectVip': {
        await rejectVip(databases, payload);
        return respond(res, 200, { success: true });
      }
      default:
        return respond(res, 400, { error: 'Unknown action' });
    }
  } catch (err) {
    error(err.message);
    return respond(res, 500, { error: err.message || 'Internal error' });
  }
}

async function getProductDiscount(databases, productId) {
  try {
    const product = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.PRODUCTS, productId);
    if (product.hasAutomaticDiscount && product.discountEnabled) {
      return { type: product.discountType, value: product.discountValue };
    }
  } catch (err) { }
  return null;
}

async function calculatePrice(databases, { productId, discountCode = null, userId }) {
  const product = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.PRODUCTS, productId);
  const user = userId ? await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, userId) : null;
  const original = Number(product.price || 0);
  let final = original;
  const breakdown = [];

  const auto = await getProductDiscount(databases, productId);
  if (auto) {
    const saved = auto.type === 'percent' ? Math.round(original * (auto.value / 100)) : Math.min(auto.value, original);
    final -= saved;
    breakdown.push({ label: 'Product discount', amount: saved });
  }

  let codeStackable = true;
  if (discountCode) {
    const codeResult = await validateDiscountCode(databases, { code: discountCode, productId });
    if (!codeResult.error && codeResult.record) {
      const rec = codeResult.record;
      codeStackable = rec.stackable;
      let saved = 0;
      if (rec.type === 'percent') saved = Math.round(final * (rec.value / 100));
      else if (rec.type === 'fixed') saved = Math.min(rec.value, final);
      final -= saved;
      breakdown.push({ label: `Code ${rec.code}`, amount: saved });
    }
  }

  if (codeStackable && user && user.loyaltyTier) {
    const tier = CONFIG.LOYALTY_TIERS.find(t => t.id === user.loyaltyTier);
    if (tier) {
      const saved = Math.round(final * (tier.discount / 100));
      final -= saved;
      breakdown.push({ label: `${tier.label} loyalty`, amount: saved });
    }
  }

  if (codeStackable && user && user.vipStatus === 'active' && user.vipExpiry && !isExpired(user.vipExpiry)) {
    const saved = Math.round(final * 0.15);
    final -= saved;
    breakdown.push({ label: 'VIP discount', amount: saved });
  }

  final = Math.max(0, final);
  return { original, final, discount: original - final, savings: original - final, breakdown };
}

async function validateDiscountCode(databases, { code, productId }) {
  if (!code) return { error: 'No code provided' };
  try {
    const result = await databases.listDocuments(
      CONFIG.DATABASE_ID,
      CONFIG.COLLECTIONS.DISCOUNT_CODES,
      [Query.equal('code', code.toUpperCase()), Query.equal('active', true)]
    );
    if (!result.documents.length) return { error: 'Invalid discount code' };
    const rec = result.documents[0];
    if (isExpired(rec.expiryDate)) return { error: 'Discount code expired' };
    if (rec.usageLimit && rec.usedCount >= rec.usageLimit) return { error: 'Usage limit reached' };
    if (rec.minPurchaseAmount) {
      const product = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.PRODUCTS, productId);
      if (product.price < rec.minPurchaseAmount) return { error: `Minimum purchase is ${formatCurrency(rec.minPurchaseAmount)}` };
    }
    if (!rec.appliesGlobally && rec.appliesToProducts && rec.appliesToProducts.length && !rec.appliesToProducts.includes(productId)) {
      return { error: 'Code does not apply to this product' };
    }
    return { record: rec };
  } catch (err) {
    return { error: err.message };
  }
}

async function submitOrder(databases, storage, { userId, productId, paymentMethod, screenshotBase64, discountCode, notes }) {
  const user = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, userId);
  const product = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.PRODUCTS, productId);
  const pricing = await calculatePrice(databases, { productId, discountCode, userId });

  const orderId = uid('ord');
  let screenshotFileId = null;
  if (screenshotBase64) {
    const base64Data = screenshotBase64.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const inputFile = InputFile.fromBuffer(buffer, 'payment.jpg');
    const file = await storage.createFile(CONFIG.BUCKETS.PAYMENTS, orderId, inputFile);
    screenshotFileId = file.$id;
  }

  const now = new Date().toISOString();
  const data = {
    orderId,
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: user.phoneNumber || '',
    productId: product.$id,
    productName: product.name,
    productPrice: product.price,
    paymentMethod,
    screenshotFileId,
    originalPrice: pricing.original,
    finalPrice: pricing.final,
    discountAmount: pricing.discount,
    discountBreakdown: JSON.stringify(pricing.breakdown),
    discountCode: discountCode || '',
    notes: notes || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };

  const order = await databases.createDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.ORDERS, orderId, data);

  // Increment discount code usage if applicable
  if (discountCode) {
    try {
      const codeRes = await databases.listDocuments(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.DISCOUNT_CODES, [Query.equal('code', discountCode.toUpperCase())], 1);
      if (codeRes.documents.length) {
        const codeDoc = codeRes.documents[0];
        await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.DISCOUNT_CODES, codeDoc.$id, {
          usedCount: (codeDoc.usedCount || 0) + 1,
          updatedAt: new Date().toISOString()
        });
      }
    } catch (err) { /* ignore increment errors */ }
  }

  return order;
}

async function submitVip(databases, storage, { userId, planType, paymentMethod, screenshotBase64 }) {
  const user = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, userId);
  const plan = CONFIG.VIP_PLANS[planType];
  if (!plan) throw new Error('Invalid VIP plan');
  const purchaseId = uid('vip');
  let screenshotFileId = null;
  if (screenshotBase64) {
    const base64Data = screenshotBase64.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const inputFile = InputFile.fromBuffer(buffer, 'vip.jpg');
    const file = await storage.createFile(CONFIG.BUCKETS.VIP, purchaseId, inputFile);
    screenshotFileId = file.$id;
  }
  const data = {
    purchaseId,
    userId: user.$id,
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: user.phoneNumber || '',
    planType: plan.id,
    price: plan.price,
    durationDays: plan.durationDays,
    paymentMethod,
    screenshotFileId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  return await databases.createDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.VIP_PURCHASES, purchaseId, data);
}

async function spinWheel(databases, { userId }) {
  const user = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, userId);
  if (user.wheelTickets <= 0) throw new Error('No wheel tickets available');
  const prizesRes = await databases.listDocuments(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.WHEEL_PRIZES, [Query.equal('active', true)]);
  const prizes = prizesRes.documents.length ? prizesRes.documents : [
    { id: 'try_again', label: 'Try Again', type: 'none', value: 0, weight: 50 },
    { id: 'off_5', label: '5% Off', type: 'percent', value: 5, weight: 25 },
    { id: 'off_10', label: '10% Off', type: 'percent', value: 10, weight: 12 },
    { id: 'off_15', label: '15% Off', type: 'percent', value: 15, weight: 7 },
    { id: 'off_5000', label: '5,000 IQD Off', type: 'fixed', value: 5000, weight: 4 },
    { id: 'free_under_20k', label: 'Free Game Under 20,000 IQD', type: 'free_game', value: 20000, weight: 2 }
  ];
  const winner = weightedRandom(prizes);

  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, userId, {
    wheelTickets: Math.max(0, user.wheelTickets - 1),
    updatedAt: new Date().toISOString()
  });

  await databases.createDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.WHEEL_SPINS, uid('spin'), {
    userId,
    telegramId: user.telegramId,
    prizeId: winner.id || winner.$id,
    prizeLabel: winner.label,
    prizeType: winner.type,
    prizeValue: winner.value,
    createdAt: new Date().toISOString()
  });

  return { winner, ticketsLeft: user.wheelTickets - 1 };
}

async function approveOrder(databases, { orderId }) {
  const order = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.ORDERS, orderId);
  if (!order) throw new Error('Order not found');
  const now = new Date().toISOString();
  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.ORDERS, orderId, { status: 'approved', updatedAt: now });

  const userRes = await databases.listDocuments(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, [Query.equal('telegramId', order.telegramId)], 1);
  if (!userRes.documents.length) return;
  const user = userRes.documents[0];
  const amount = Number(order.finalPrice || 0);
  const points = amount > 10000 ? 1 : 0;
  const extraVipPoint = user.vipStatus === 'active' && user.vipExpiry && !isExpired(user.vipExpiry) ? 1 : 0;
  const totalPoints = user.loyaltyPoints + points + extraVipPoint;
  const tier = getTier(totalPoints);
  const tickets = user.wheelTickets + 1 + (user.vipStatus === 'active' && !isExpired(user.vipExpiry) ? 1 : 0);
  const purchases = user.totalPurchases + 1;
  const spending = user.totalSpending + amount;
  const leaderboardPoints = user.leaderboardPoints + Math.max(1, Math.floor(amount / 10000));

  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, user.$id, {
    loyaltyPoints: totalPoints, loyaltyTier: tier.id, wheelTickets: tickets,
    totalPurchases: purchases, totalSpending: spending, leaderboardPoints,
    updatedAt: now
  });

  await upsertLeaderboard(databases, user, leaderboardPoints);
}

async function rejectOrder(databases, { orderId }) {
  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.ORDERS, orderId, {
    status: 'rejected', updatedAt: new Date().toISOString()
  });
}

async function rejectVip(databases, { purchaseId }) {
  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.VIP_PURCHASES, purchaseId, {
    status: 'rejected', updatedAt: new Date().toISOString()
  });
}

async function activateVip(databases, { purchaseId }) {
  const purchase = await databases.getDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.VIP_PURCHASES, purchaseId);
  const plan = CONFIG.VIP_PLANS[purchase.planType];
  const startDate = new Date().toISOString();
  const expiryDate = plan.durationDays ? addDays(startDate, plan.durationDays) : null;
  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.VIP_PURCHASES, purchaseId, {
    status: 'active', approvedAt: startDate, approvedBy: 'function', updatedAt: startDate
  });
  await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.USERS, purchase.userId, {
    vipStatus: 'active', vipExpiry: expiryDate, vipPlan: plan.id, updatedAt: startDate
  });
  await databases.createDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.VIP_MEMBERS, uid('vm'), {
    userId: purchase.userId,
    telegramId: purchase.telegramId,
    planType: plan.id,
    price: purchase.price,
    status: 'active',
    startDate,
    expiryDate,
    paymentMethod: purchase.paymentMethod,
    screenshotFileId: purchase.screenshotFileId || '',
    approvedBy: 'function',
    approvedAt: startDate,
    createdAt: startDate,
    updatedAt: startDate
  });
}

async function upsertLeaderboard(databases, user, points) {
  const res = await databases.listDocuments(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.LEADERBOARD, [Query.equal('telegramId', user.telegramId)], 1);
  const data = {
    telegramId: user.telegramId, username: user.username, firstName: user.firstName, lastName: user.lastName,
    points, loyaltyTier: user.loyaltyTier, updatedAt: new Date().toISOString()
  };
  if (res.documents.length) {
    await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.LEADERBOARD, res.documents[0].$id, data);
  } else {
    await databases.createDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.LEADERBOARD, uid('lb'), { ...data, createdAt: new Date().toISOString() });
  }
}
