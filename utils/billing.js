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

async function activateProPlan(user, billingCycle = 'monthly') {
  const durationDays = billingCycle === 'yearly' ? 365 : 30;
  const now = Date.now();
  const currentExpiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : 0;
  const baseTimestamp = currentExpiry > now ? currentExpiry : now;

  user.plan = 'pro';
  user.storageLimit = PRO_STORAGE_LIMIT;
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
  activateProPlan
};
