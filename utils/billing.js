const FREE_STORAGE_LIMIT = 1 * 1024 * 1024 * 1024;
const PRO_MONTHLY_PRICE = 49000;
const PRO_YEARLY_PRICE = 490000;
const PRO_STORAGE_LIMIT = 50 * 1024 * 1024 * 1024;

const PLAN_CATALOG = Object.freeze({
  free: {
    key: 'free',
    name: 'Free',
    badge: 'Starter',
    storageLimit: FREE_STORAGE_LIMIT,
    icon: 'fa-seedling',
    seatLabel: 'Free Member',
    features: [
      '1 GB synced storage',
      'Basic public profile',
      'Core upload workflow'
    ]
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    badge: 'Premium',
    storageLimit: PRO_STORAGE_LIMIT,
    icon: 'fa-crown',
    seatLabel: 'PRO Member',
    features: [
      '50 GB synced storage',
      'Premium branding controls',
      'Priority workspace features'
    ]
  }
});

function applyPlanToUser(user, plan = 'free') {
  const summary = getPlanSummary(plan);
  user.plan = summary.key;
  user.storageLimit = summary.storageLimit;
  return user;
}

function getBillingPricing() {
  return {
    monthlyPrice: PRO_MONTHLY_PRICE,
    yearlyPrice: PRO_YEARLY_PRICE
  };
}

function getBillingAmount(billingCycle = 'monthly') {
  return billingCycle === 'yearly' ? PRO_YEARLY_PRICE : PRO_MONTHLY_PRICE;
}

function getPlanCatalog() {
  return PLAN_CATALOG;
}

function getPlanSummary(plan = 'free') {
  return PLAN_CATALOG[plan] || PLAN_CATALOG.free;
}

function hasProPlanAccess(user) {
  return Boolean(user && user.plan === 'pro');
}

async function downgradeToFreePlan(user) {
  applyPlanToUser(user, 'free');
  user.subscriptionCycle = 'monthly';
  user.subscriptionExpiresAt = null;
  await user.save();
  return user;
}

async function syncUserPlanState(user) {
  if (!user) return user;
  if (user.plan !== 'pro') {
    applyPlanToUser(user, 'free');
    return user;
  }

  const expiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : 0;
  if (!expiry || expiry <= Date.now()) {
    await downgradeToFreePlan(user);
    return user;
  }

  applyPlanToUser(user, 'pro');
  return user;
}

async function activateProPlan(user, billingCycle = 'monthly') {
  const durationDays = billingCycle === 'yearly' ? 365 : 30;
  const now = Date.now();
  const currentExpiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : 0;
  const baseTimestamp = currentExpiry > now ? currentExpiry : now;

  applyPlanToUser(user, 'pro');
  user.subscriptionCycle = billingCycle;
  user.lastPaymentAt = new Date();
  user.subscriptionExpiresAt = new Date(baseTimestamp + durationDays * 24 * 60 * 60 * 1000);
  await user.save();

  return user.subscriptionExpiresAt;
}

module.exports = {
  FREE_STORAGE_LIMIT,
  PRO_STORAGE_LIMIT,
  getBillingPricing,
  getBillingAmount,
  getPlanCatalog,
  getPlanSummary,
  hasProPlanAccess,
  applyPlanToUser,
  downgradeToFreePlan,
  syncUserPlanState,
  activateProPlan
};
