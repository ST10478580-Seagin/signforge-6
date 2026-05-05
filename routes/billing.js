const express = require('express');
const router  = express.Router();
const https   = require('https');
const auth    = require('../middleware/auth');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';

// Plan prices in kobo (ZAR cents — Paystack uses smallest currency unit)
const PLANS = {
  starter: { amount: 1900, label: 'Starter Plan' }, // R19.00
  pro:     { amount: 4900, label: 'Pro Plan'      }  // R49.00
};

// Helper: call Paystack API
function paystackRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// GET /api/billing/subscription
router.get('/subscription', auth, (req, res) => {
  const u = req.user;
  res.json({
    subscription: {
      plan:   u.plan || 'free',
      status: u.plan !== 'free' ? 'active' : 'free'
    }
  });
});

// POST /api/billing/create-checkout  { plan: 'starter'|'pro' }
router.post('/create-checkout', auth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  if (!PAYSTACK_SECRET || PAYSTACK_SECRET.includes('REPLACE') || PAYSTACK_SECRET === '') {
    // Demo mode — no real Paystack key yet
    return res.json({ demoMode: true });
  }

  try {
    const appUrl = process.env.APP_URL || 'https://signforge-6-wtru.onrender.com';

    const result = await paystackRequest('/transaction/initialize', {
      email:        req.user.email,
      amount:       PLANS[plan].amount,
      currency:     'ZAR',
      callback_url: `${appUrl}/payment-success?plan=${plan}`,
      metadata: {
        userId: req.user.id,
        plan,
        cancel_action: `${appUrl}/billing`
      }
    });

    if (result.status === 200 && result.body.status === true) {
      return res.json({ url: result.body.data.authorization_url });
    }

    throw new Error(result.body.message || 'Paystack error');
  } catch (err) {
    console.error('Paystack checkout error:', err);
    res.status(500).json({ error: 'Payment failed. Try again.' });
  }
});

// POST /api/billing/demo-upgrade  (demo mode only)
router.post('/demo-upgrade', auth, (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  req.user.plan = plan;
  res.json({ success: true, plan });
});

// POST /api/billing/webhook  (Paystack webhook)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify the event is from Paystack using your secret key
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body);

    if (event.event === 'charge.success') {
      const { userId, plan } = event.data.metadata || {};
      if (userId && plan) {
        const db = require('../db');
        const user = db.users.find(u => u.id === userId);
        if (user) user.plan = plan;
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(400).json({ error: 'Webhook error' });
  }
});

// POST /api/billing/cancel
router.post('/cancel', auth, (req, res) => {
  req.user.plan = 'free';
  res.json({ success: true });
});

module.exports = router;
