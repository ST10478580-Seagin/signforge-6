const express = require('express');
const router  = express.Router();
const https   = require('https');
const auth    = require('../middleware/auth');

const YOCO_SECRET = process.env.YOCO_SECRET || '';

// Plan prices in cents (ZAR) — Yoco requires cents
const PLANS = {
  starter: { amount: 1900, label: 'Starter Plan' },
  pro:     { amount: 4900, label: 'Pro Plan'     }
};

// Helper: call Yoco API
function yocoRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'online.yoco.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${YOCO_SECRET}`,
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

  if (!YOCO_SECRET || YOCO_SECRET.includes('REPLACE')) {
    // Demo mode — no real Yoco key yet
    return res.json({ demoMode: true });
  }

  try {
    const appUrl = process.env.APP_URL || 'https://signforge-6-wtru.onrender.com';

    const result = await yocoRequest('/v1/checkouts', {
      amount:     PLANS[plan].amount,
      currency:   'ZAR',
      successUrl: `${appUrl}/payment-success?plan=${plan}`,
      cancelUrl:  `${appUrl}/billing`,
      metadata:   { userId: req.user.id, plan }
    });

    console.log('Yoco response:', result.status, JSON.stringify(result.body));

    if (result.status === 200 || result.status === 201) {
      // Yoco returns redirectUrl or url depending on version
      const redirectUrl = result.body.redirectUrl || result.body.url;
      if (!redirectUrl) throw new Error('No redirect URL returned from Yoco');
      return res.json({ url: redirectUrl });
    }

    throw new Error(result.body?.message || result.body?.error || 'Yoco error');
  } catch (err) {
    console.error('Yoco checkout error:', err);
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

// POST /api/billing/webhook  (Yoco webhook)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = JSON.parse(req.body);
    if (event.type === 'payment.succeeded') {
      const { userId, plan } = event.payload?.metadata || {};
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
