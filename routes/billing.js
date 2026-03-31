const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const auth    = require('../middleware/auth');

const MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID  || '';
const MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '';
const PASSPHRASE   = process.env.PAYFAST_PASSPHRASE   || '';
const APP_URL      = process.env.APP_URL || 'https://signforge-6-wtru.onrender.com';

const PLANS = {
  starter: { amount: '19.99', name: 'SignForge Starter Plan', frequency: 3, cycles: 0 },
  pro:     { amount: '49.99', name: 'SignForge Pro Plan',     frequency: 3, cycles: 0 }
};

function buildSignature(data) {
  let str = Object.keys(data)
    .filter(k => data[k] !== '' && data[k] !== null && data[k] !== undefined)
    .map(k => `${k}=${encodeURIComponent(String(data[k])).replace(/%20/g, '+')}`)
    .join('&');
  if (PASSPHRASE) str += `&passphrase=${encodeURIComponent(PASSPHRASE).replace(/%20/g, '+')}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

router.get('/subscription', auth, (req, res) => {
  const u = req.user;
  res.json({
    subscription: {
      plan:   u.plan || 'free',
      status: u.plan !== 'free' ? 'active' : 'free'
    }
  });
});

router.post('/create-checkout', auth, (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  if (!MERCHANT_ID || !MERCHANT_KEY) {
    return res.json({ demoMode: true });
  }

  const p = PLANS[plan];
  const data = {
    merchant_id:       MERCHANT_ID,
    merchant_key:      MERCHANT_KEY,
    return_url:        `${APP_URL}/payment-success?plan=${plan}`,
    cancel_url:        `${APP_URL}/billing`,
    notify_url:        `${APP_URL}/api/billing/webhook`,
    name_first:        req.user.name.split(' ')[0] || 'Customer',
    name_last:         req.user.name.split(' ').slice(1).join(' ') || 'User',
    email_address:     req.user.email,
    m_payment_id:      `${req.user.id}-${plan}-${Date.now()}`,
    amount:            p.amount,
    item_name:         p.name,
    subscription_type: 1,
    billing_date:      new Date().toISOString().split('T')[0],
    recurring_amount:  p.amount,
    frequency:         p.frequency,
    cycles:            p.cycles,
    custom_str1:       req.user.id,
    custom_str2:       plan,
  };

  data.signature = buildSignature(data);

  const payfastUrl = 'https://www.payfast.co.za/eng/process?' +
    Object.keys(data)
      .map(k => `${k}=${encodeURIComponent(String(data[k]))}`)
      .join('&');

  res.json({ url: payfastUrl });
});

router.post('/demo-upgrade', auth, (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  req.user.plan = plan;
  res.json({ success: true, plan });
});

router.post('/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = req.body;
    const userId = data.custom_str1;
    const plan   = data.custom_str2;
    if (data.payment_status === 'COMPLETE' && userId && plan) {
      const db = require('../db');
      const user = db.users.find(u => u.id === userId);
      if (user) { user.plan = plan; console.log(`User ${userId} upgraded to ${plan}`); }
    }
    res.send('OK');
  } catch (e) { console.error('Webhook error:', e); res.send('OK'); }
});

router.post('/cancel', auth, (req, res) => {
  req.user.plan = 'free';
  res.json({ success: true });
});

module.exports = router;
