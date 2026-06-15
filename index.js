const sdk = require('node-appwrite');
const crypto = require('crypto');

module.exports = async function (context) {
    const payload = context.req.body ? JSON.parse(context.req.body) : {};
    const action = payload.action;

    const client = new sdk.Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);
    const storage = new sdk.Storage(client);

    const dbId = process.env.STORE_DATABASE_ID || 'store';
    const colId = {
        users: 'users',
        products: 'products',
        categories: 'categories',
        orders: 'orders',
        wheelPrizes: 'wheelPrizes',
        wheelSpins: 'wheelSpins',
        leaderboard: 'leaderboard',
        weeklyWinners: 'weeklyWinners',
        vipMembers: 'vipMembers',
        discountCodes: 'discountCodes',
        productDiscounts: 'productDiscounts',
        settings: 'settings'
    };
    const buckets = {
        products: 'productImages',
        payments: 'paymentProofs',
        avatars: 'avatars'
    };

    const ADMIN_IDS = (await getAdminIds(databases, dbId, colId.settings)) || [];
    const appwriteUserId = context.req?.userId || '';

    context.log('businessLogic called', { action, appwriteUserId: appwriteUserId || null, hasInitData: !!payload?.initData });

    try {
        // Verify Telegram initData for sensitive user-initiated actions.
        // The Appwrite session (context.req.userId) is used to scope document permissions securely.
        if (['submitOrder', 'submitVIP', 'spinWheel'].includes(action)) {
            if (!payload.initData || !verifyTelegramData(payload.initData)) {
                return context.res.json({ success: false, message: 'Invalid Telegram authentication data' }, 401);
            }
            if (!appwriteUserId) {
                return context.res.json({ success: false, message: 'Appwrite session not found' }, 401);
            }
        }

        switch (action) {
            case 'verifyTelegram':
                return context.res.json({ success: verifyTelegramData(payload.initData) });
            case 'initUser':
                return await initUser(context, databases, dbId, colId, payload);
            case 'submitOrder':
                return await submitOrder(context, databases, dbId, colId, payload, ADMIN_IDS, appwriteUserId);
            case 'approveOrder':
                return await approveOrder(context, databases, dbId, colId, payload, ADMIN_IDS);
            case 'rejectOrder':
                return await rejectOrder(context, databases, dbId, colId, payload, ADMIN_IDS);
            case 'submitVIP':
                return await submitVIP(context, databases, dbId, colId, payload, ADMIN_IDS, appwriteUserId);
            case 'approveVIP':
                return await approveVIP(context, databases, dbId, colId, payload, ADMIN_IDS);
            case 'rejectVIP':
                return await rejectVIP(context, databases, dbId, colId, payload, ADMIN_IDS);
            case 'spinWheel':
                return await spinWheel(context, databases, dbId, colId, payload, appwriteUserId);
            case 'validateDiscountCode':
                return await validateDiscountCode(context, databases, dbId, colId, payload);
            case 'getUser':
                return await getUser(context, databases, dbId, colId, payload);
            case 'updateUser':
                return await updateUser(context, databases, dbId, colId, payload);
            case 'getVIPStatus':
                return await getVIPStatus(context, databases, dbId, colId, payload);
            case 'getActiveVIP':
                return await getActiveVIP(context, databases, dbId, colId, payload);
            default:
                return context.res.json({ success: false, message: 'Unknown action' }, 400);
        }
    } catch (e) {
        context.error('Business logic error:', e);
        return context.res.json({ success: false, message: e.message || 'Internal error' }, 500);
    }
};

async function getAdminIds(databases, dbId, settingsCol) {
    try {
        const result = await databases.listDocuments(dbId, settingsCol, [sdk.Query.equal('key', 'adminIds')]);
        if (result.documents.length) return result.documents[0].value || [];
    } catch (e) {}
    return (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
}

function verifyTelegramData(initData) {
    if (!initData) return false;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken) return true; // Cannot verify without bot token, fail-open for dev only

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = Array.from(params.keys()).sort().map(k => `${k}=${params.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return checkHash === hash;
}


async function getUserDocByAppwriteId(databases, dbId, colId, appwriteUserId) {
    try {
        return await databases.getDocument(dbId, colId, appwriteUserId);
    } catch (e) {
        return null;
    }
}

async function getUserDocByTelegramId(databases, dbId, colId, telegramId) {
    try {
        const result = await databases.listDocuments(dbId, colId, [sdk.Query.equal('telegramId', telegramId), sdk.Query.limit(1)]);
        return result.documents[0] || null;
    } catch (e) {
        return null;
    }
}

async function initUser(context, databases, dbId, colId, payload) {
    const { initData, initDataUnsafe } = payload;
    if (!initData || !verifyTelegramData(initData)) {
        return context.res.json({ success: false, message: 'Invalid Telegram authentication data' }, 401);
    }

    const appwriteUserId = context.req?.userId;
    if (!appwriteUserId) {
        return context.res.json({ success: false, message: 'Appwrite session not found. Ensure the function is called with an authenticated Appwrite session.' }, 401);
    }

    const tgUser = initDataUnsafe?.user || {};
    const telegramId = String(tgUser.id || '');
    if (!telegramId) return context.res.json({ success: false, message: 'Telegram ID missing' }, 400);

    const now = new Date().toISOString();
    const userData = {
        userId: appwriteUserId,
        telegramId,
        username: tgUser.username || '',
        firstName: tgUser.first_name || 'User',
        lastName: tgUser.last_name || '',
        fullName: [tgUser.first_name || '', tgUser.last_name || ''].filter(Boolean).join(' ') || 'User',
        photoUrl: tgUser.photo_url || '',
        languageCode: tgUser.language_code || 'en',
        isPremium: !!tgUser.is_premium,
        phoneNumber: '',
        role: 'user',
        banned: false,
        loyaltyPoints: 0,
        leaderboardPoints: 0,
        totalPurchases: 0,
        totalSpending: 0,
        rewardTickets: 0,
        vipActive: false,
        vipExpiry: '',
        createdAt: now,
        lastActive: now,
        settings: {}
    };

    try {
        const existing = await databases.getDocument(dbId, colId.users, appwriteUserId);
        const updateData = {};
        if (existing.telegramId !== telegramId) updateData.telegramId = telegramId;
        if (existing.username !== userData.username) updateData.username = userData.username;
        if (existing.firstName !== userData.firstName) updateData.firstName = userData.firstName;
        if (existing.lastName !== userData.lastName) updateData.lastName = userData.lastName;
        if (existing.photoUrl !== userData.photoUrl) updateData.photoUrl = userData.photoUrl;
        if (existing.languageCode !== userData.languageCode) updateData.languageCode = userData.languageCode;
        if (existing.isPremium !== userData.isPremium) updateData.isPremium = userData.isPremium;
        if (existing.userId !== appwriteUserId) updateData.userId = appwriteUserId;
        updateData.lastActive = now;

        if (Object.keys(updateData).length > 0) {
            await databases.updateDocument(dbId, colId.users, appwriteUserId, updateData, [
                sdk.Permission.read(sdk.Role.user(appwriteUserId)),
                sdk.Permission.update(sdk.Role.user(appwriteUserId))
            ]);
        }
        return context.res.json({ success: true, userId: appwriteUserId, created: false });
    } catch (e) {
        // Document not found, create new user
        await databases.createDocument(dbId, colId.users, appwriteUserId, userData, [
            sdk.Permission.read(sdk.Role.user(appwriteUserId)),
            sdk.Permission.update(sdk.Role.user(appwriteUserId))
        ]);
        return context.res.json({ success: true, userId: appwriteUserId, created: true });
    }
}

async function submitOrder(context, databases, dbId, colId, payload, adminIds, appwriteUserId) {
    const { telegramId, productId, productName, productPrice, effectivePrice, paymentMethod, discountCode, appliedDiscounts } = payload;
    if (!telegramId || !productId) throw new Error('Missing required fields');

    let userDoc = await getUserDocByAppwriteId(databases, dbId, colId.users, appwriteUserId);
    if (!userDoc) throw new Error('User not found');
    if (userDoc.banned) throw new Error('Account is banned');

    const now = new Date().toISOString();
    const orderId = sdk.ID.unique();
    const orderData = {
        telegramId,
        username: payload.username || '',
        firstName: payload.firstName || '',
        lastName: payload.lastName || '',
        phoneNumber: payload.phoneNumber || '',
        productId,
        productName,
        originalPrice: productPrice,
        finalAmount: effectivePrice,
        paymentMethod,
        discountCode: discountCode || '',
        appliedDiscounts: JSON.stringify(appliedDiscounts || []),
        status: 'pending',
        adminNotes: '',
        rejectionReason: '',
        screenshotFileId: '',
        screenshotUrl: '',
        createdAt: now,
        $permissions: [sdk.Permission.read(sdk.Role.user(appwriteUserId))]
    };

    await databases.createDocument(dbId, colId.orders, orderId, orderData);

    await notifyAdmins(databases, dbId, colId, adminIds, {
        type: 'new_order',
        title: 'New Order Request',
        text: `Customer: ${payload.firstName} ${payload.lastName} (@${payload.username || 'N/A'}, ${telegramId})\nProduct: ${productName}\nFinal: ${effectivePrice} IQD\nMethod: ${paymentMethod}\nPhone: ${payload.phoneNumber || 'N/A'}`,
        orderId
    });

    return context.res.json({ success: true, orderId });
}

async function approveOrder(context, databases, dbId, colId, payload, adminIds) {
    const { orderId, adminTelegramId } = payload;
    if (!adminIds.includes(parseInt(adminTelegramId))) throw new Error('Unauthorized');

    const order = await databases.getDocument(dbId, colId.orders, orderId);
    if (order.status !== 'pending') throw new Error('Order is not pending');

    const userDoc = await getUserDocByTelegramId(databases, dbId, colId.users, order.telegramId);
    if (!userDoc) throw new Error('User not found for this order');
    const finalAmount = parseFloat(order.finalAmount) || 0;

    // Update order status
    await databases.updateDocument(dbId, colId.orders, orderId, {
        status: 'approved',
        adminNotes: payload.adminNotes || '',
        approvedAt: new Date().toISOString(),
        approvedBy: adminTelegramId
    });

    // Increment discount code usage if applicable
    if (order.discountCode) {
        try {
            const codeResult = await databases.listDocuments(dbId, colId.discountCodes, [sdk.Query.equal('code', order.discountCode)]);
            if (codeResult.documents.length) {
                const disc = codeResult.documents[0];
                await databases.updateDocument(dbId, colId.discountCodes, disc.$id, {
                    usedCount: (disc.usedCount || 0) + 1
                });
            }
        } catch (e) {}
    }

    // Update user stats
    const isVipActive = userDoc.vipActive && (!userDoc.vipExpiry || new Date(userDoc.vipExpiry) > new Date());
    const loyaltyPoints = (userDoc.loyaltyPoints || 0) + (finalAmount > 10000 ? 1 : 0) + (isVipActive ? 1 : 0);
    const totalPurchases = (userDoc.totalPurchases || 0) + 1;
    const totalSpending = (userDoc.totalSpending || 0) + finalAmount;
    const rewardTickets = (userDoc.rewardTickets || 0) + 1 + (isVipActive ? 1 : 0);
    const leaderboardPoints = (userDoc.leaderboardPoints || 0) + Math.floor(finalAmount / 1000);

    await databases.updateDocument(dbId, colId.users, order.telegramId, {
        loyaltyPoints,
        totalPurchases,
        totalSpending,
        rewardTickets,
        leaderboardPoints
    });

    // Update leaderboard
    await updateLeaderboard(databases, dbId, colId, order.telegramId, userDoc.username, userDoc.firstName, userDoc.lastName, leaderboardPoints, loyaltyPoints);

    // Update product stock if tracked
    if (order.productId) {
        try {
            const product = await databases.getDocument(dbId, colId.products, order.productId);
            if (product.stockQuantity !== null && product.stockQuantity !== undefined && product.stockQuantity > 0) {
                await databases.updateDocument(dbId, colId.products, order.productId, {
                    stockQuantity: product.stockQuantity - 1,
                    status: product.stockQuantity - 1 <= 0 ? 'out_of_stock' : product.status
                });
            }
        } catch (e) {}
    }

    await notifyAdmins(databases, dbId, colId, adminIds, {
        type: 'order_approved',
        title: 'Order Approved',
        text: `Order #${orderId.slice(-8)} approved by admin ${adminTelegramId}`,
        orderId
    });

    return context.res.json({ success: true, orderId });
}

async function rejectOrder(context, databases, dbId, colId, payload, adminIds) {
    const { orderId, adminTelegramId } = payload;
    if (!adminIds.includes(parseInt(adminTelegramId))) throw new Error('Unauthorized');

    const order = await databases.getDocument(dbId, colId.orders, orderId);
    if (order.status !== 'pending') throw new Error('Order is not pending');

    await databases.updateDocument(dbId, colId.orders, orderId, {
        status: 'rejected',
        rejectionReason: payload.reason || '',
        adminNotes: payload.reason || '',
        rejectedAt: new Date().toISOString()
    });

    return context.res.json({ success: true, orderId });
}

async function submitVIP(context, databases, dbId, colId, payload, adminIds, appwriteUserId) {
    const { telegramId, planType, price, paymentMethod } = payload;
    if (!telegramId || !planType) throw new Error('Missing VIP fields');

    const userDoc = await getUserDocByAppwriteId(databases, dbId, colId.users, appwriteUserId);
    if (!userDoc) throw new Error('User not found');
    if (userDoc.banned) throw new Error('Account is banned');

    const now = new Date().toISOString();
    let expiryDate = '';
    if (planType !== 'lifetime') {
        const days = planType === 'monthly' ? 30 : 365;
        const d = new Date();
        d.setDate(d.getDate() + days);
        expiryDate = d.toISOString();
    }

    const vipId = sdk.ID.unique();
    await databases.createDocument(dbId, colId.vipMembers, vipId, {
        telegramId,
        username: payload.username || '',
        firstName: payload.firstName || '',
        lastName: payload.lastName || '',
        phoneNumber: payload.phoneNumber || '',
        planType,
        price,
        paymentMethod,
        status: 'pending',
        startDate: '',
        expiryDate,
        screenshotFileId: '',
        screenshotUrl: '',
        approvedBy: '',
        approvedAt: '',
        createdAt: now,
        $permissions: [sdk.Permission.read(sdk.Role.user(appwriteUserId))]
    });

    await notifyAdmins(databases, dbId, colId, adminIds, {
        type: 'new_vip',
        title: 'New VIP Request',
        text: `Customer: ${payload.firstName} ${payload.lastName} (@${payload.username || 'N/A'})\nPlan: ${planType}\nPrice: ${price} IQD\nMethod: ${paymentMethod}`,
        vipId
    });

    return context.res.json({ success: true, vipId });
}

async function approveVIP(context, databases, dbId, colId, payload, adminIds) {
    const { vipId, adminTelegramId } = payload;
    if (!adminIds.includes(parseInt(adminTelegramId))) throw new Error('Unauthorized');

    const vip = await databases.getDocument(dbId, colId.vipMembers, vipId);
    if (vip.status !== 'pending') throw new Error('VIP is not pending');

    const now = new Date();
    let expiryDate = vip.expiryDate || '';
    if (!expiryDate && vip.planType !== 'lifetime') {
        const days = vip.planType === 'monthly' ? 30 : 365;
        const d = new Date(now);
        d.setDate(d.getDate() + days);
        expiryDate = d.toISOString();
    }

    await databases.updateDocument(dbId, colId.vipMembers, vipId, {
        status: 'active',
        startDate: now.toISOString(),
        expiryDate,
        approvedBy: adminTelegramId,
        approvedAt: now.toISOString()
    });

    const userDoc = await getUserDocByTelegramId(databases, dbId, colId.users, vip.telegramId);
    if (userDoc) {
        await databases.updateDocument(dbId, colId.users, userDoc.$id, {
            vipActive: true,
            vipExpiry: expiryDate
        });
    }

    return context.res.json({ success: true, vipId });
}

async function rejectVIP(context, databases, dbId, colId, payload, adminIds) {
    const { vipId, adminTelegramId } = payload;
    if (!adminIds.includes(parseInt(adminTelegramId))) throw new Error('Unauthorized');

    await databases.updateDocument(dbId, colId.vipMembers, vipId, {
        status: 'rejected',
        rejectionReason: payload.reason || '',
        rejectedAt: new Date().toISOString()
    });

    return context.res.json({ success: true, vipId });
}

async function spinWheel(context, databases, dbId, colId, payload, appwriteUserId) {
    const { telegramId } = payload;
    const userDoc = await getUserDocByAppwriteId(databases, dbId, colId.users, appwriteUserId);
    if (!userDoc) throw new Error('User not found');
    if (userDoc.banned) throw new Error('Account is banned');
    if ((userDoc.rewardTickets || 0) <= 0) throw new Error('No tickets available');

    const prizesResult = await databases.listDocuments(dbId, colId.wheelPrizes, [sdk.Query.equal('enabled', true)]);
    const prizes = prizesResult.documents;
    if (!prizes.length) throw new Error('No prizes available');

    // Weighted random selection
    const totalWeight = prizes.reduce((sum, p) => sum + (parseFloat(p.probability) || 0), 0);
    let random = Math.random() * totalWeight;
    let selectedIndex = 0;
    for (let i = 0; i < prizes.length; i++) {
        random -= parseFloat(prizes[i].probability) || 0;
        if (random <= 0) { selectedIndex = i; break; }
    }
    const prize = prizes[selectedIndex];

    // Consume ticket
    await databases.updateDocument(dbId, colId.users, userDoc.$id, {
        rewardTickets: (userDoc.rewardTickets || 0) - 1
    });

    // Record spin
    const spinId = sdk.ID.unique();
    await databases.createDocument(dbId, colId.wheelSpins, spinId, {
        telegramId,
        username: userDoc.username || '',
        firstName: userDoc.firstName || '',
        prizeId: prize.$id,
        prizeName: prize.name,
        prizeType: prize.type,
        prizeValue: prize.value,
        createdAt: new Date().toISOString(),
        $permissions: [sdk.Permission.read(sdk.Role.user(appwriteUserId))]
    });

    return context.res.json({ success: true, prizeIndex: selectedIndex, prize });
}

async function validateDiscountCode(context, databases, dbId, colId, payload) {
    const { code, productId, categoryId, cartTotal, telegramId } = payload;
    const codeUpper = (code || '').toUpperCase();
    const result = await databases.listDocuments(dbId, colId.discountCodes, [sdk.Query.equal('code', codeUpper), sdk.Query.equal('active', true)]);
    if (!result.documents.length) return context.res.json({ success: false });

    const discount = result.documents[0];
    const now = new Date();
    if (discount.expiryDate && new Date(discount.expiryDate) < now) {
        return context.res.json({ success: false, message: 'Discount code expired' });
    }
    if (discount.usageLimit && discount.usedCount >= discount.usageLimit) {
        return context.res.json({ success: false, message: 'Discount code usage limit reached' });
    }
    if (discount.minimumPurchaseAmount && cartTotal < discount.minimumPurchaseAmount) {
        return context.res.json({ success: false, message: 'Minimum purchase amount not met' });
    }
    if (discount.productRestrictions && discount.productRestrictions.length && !discount.productRestrictions.includes(productId)) {
        return context.res.json({ success: false, message: 'Code not valid for this product' });
    }
    if (discount.categoryRestrictions && discount.categoryRestrictions.length && !discount.categoryRestrictions.includes(categoryId)) {
        return context.res.json({ success: false, message: 'Code not valid for this category' });
    }

    // Note: usedCount is incremented on order approval, not validation, to avoid consuming codes for abandoned orders.
    return context.res.json({ success: true, discount: { code: discount.code, type: discount.type, value: discount.value, discountId: discount.$id } });
}

async function updateLeaderboard(databases, dbId, colId, telegramId, username, firstName, lastName, points, loyaltyPoints) {
    try {
        const existing = await databases.listDocuments(dbId, colId.leaderboard, [sdk.Query.equal('telegramId', telegramId)]);
        if (existing.documents.length) {
            await databases.updateDocument(dbId, colId.leaderboard, existing.documents[0].$id, {
                points,
                username,
                firstName,
                lastName,
                loyaltyPoints,
                tier: getTierName(loyaltyPoints),
                updatedAt: new Date().toISOString()
            });
        } else {
            await databases.createDocument(dbId, colId.leaderboard, sdk.ID.unique(), {
                telegramId,
                username,
                firstName,
                lastName,
                points,
                loyaltyPoints,
                tier: getTierName(loyaltyPoints),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        }
    } catch (e) {
        console.error('Leaderboard update error:', e);
    }
}

function getTierName(points) {
    if (points > 50) return 'Diamond';
    if (points >= 15) return 'Gold';
    if (points >= 5) return 'Silver';
    return 'Bronze';
}

async function notifyAdmins(databases, dbId, colId, adminIds, notification) {
    // In production, send Telegram messages via bot to each admin ID.
    // Here we create a notification log in the database for audit, and if a webhook is configured we trigger it.
    try {
        for (const adminId of adminIds) {
            await databases.createDocument(dbId, colId.settings, sdk.ID.unique(), {
                key: 'adminNotification',
                value: { ...notification, adminId, createdAt: new Date().toISOString() }
            }, [sdk.Permission.read(sdk.Role.user(String(adminId)))]);
        }

        // Optional: send HTTP request to your Telegram bot endpoint
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken && adminIds.length) {
            for (const adminId of adminIds) {
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: adminId,
                        text: `Store Admin Notification\n\n${notification.title}\n${notification.text}`,
                        parse_mode: 'HTML'
                    })
                }).catch(() => {});
            }
        }
    } catch (e) {
        console.error('Admin notification error:', e);
    }
}

// === New client-facing handlers (called via executeFunction) ===

async function getUser(context, databases, dbId, colId, payload) {
    const { telegramId } = payload;
    if (!telegramId) return context.res.json({ success: false, message: 'telegramId required' });
    const user = await getUserDocByTelegramId(databases, dbId, colId.users, telegramId);
    return context.res.json({ success: !!user, user: user || null });
}

async function updateUser(context, databases, dbId, colId, payload) {
    const { telegramId, update } = payload;
    if (!telegramId || !update) return context.res.json({ success: false, message: 'telegramId and update required' });
    const user = await getUserDocByTelegramId(databases, dbId, colId.users, telegramId);
    if (!user) return context.res.json({ success: false, message: 'User not found' });
    await databases.updateDocument(dbId, colId.users, user.$id, update);
    const fresh = await getUserDocByTelegramId(databases, dbId, colId.users, telegramId);
    return context.res.json({ success: true, user: fresh });
}

async function getVIPStatus(context, databases, dbId, colId, payload) {
    const { telegramId } = payload;
    if (!telegramId) return context.res.json({ success: false, message: 'telegramId required' });
    try {
        const result = await databases.listDocuments(dbId, colId.vipMembers, [
            sdk.Query.equal('telegramId', String(telegramId)),
            sdk.Query.orderDesc('$createdAt'),
            sdk.Query.limit(1)
        ]);
        const membership = result.documents[0] || null;
        return context.res.json({ success: true, membership });
    } catch (e) {
        return context.res.json({ success: false, message: e.message });
    }
}

async function getActiveVIP(context, databases, dbId, colId, payload) {
    const limit = payload.limit || 15;
    try {
        const result = await databases.listDocuments(dbId, colId.vipMembers, [
            sdk.Query.equal('status', 'active'),
            sdk.Query.orderDesc('approvedAt'),
            sdk.Query.limit(limit)
        ]);
        // Only return safe public fields
        const members = result.documents.map(m => ({
            telegramId: m.telegramId,
            username: m.username,
            firstName: m.firstName,
            photoUrl: '', // populated client-side if needed
            planType: m.planType,
            expiryDate: m.expiryDate
        }));
        return context.res.json({ success: true, members });
    } catch (e) {
        return context.res.json({ success: false, message: e.message });
    }
}
