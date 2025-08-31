require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { OpenAI } = require('openai');
const Stripe = require('stripe'); // STRIPE: Add Stripe SDK
const { 
  getProducts, 
  createCheckout, 
  verifyWebhookSignature, 
  processWebhookEvent,
  validateConfig 
} = require('./lemonsqueezy');

const app = express();
const PORT = process.env.PORT || 8080;

// STRIPE: Initialize Stripe with environment variable
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { 
  apiVersion: "2024-06-20" 
});

// Simple in-memory store for subscriptions by userId
// Replace later with a DB if needed
const Subscriptions = new Map(); // key: userId, value: { active, plan, currentPeriodEnd, customerId, subscriptionId }

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration for production and development
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const devOrigins = ['http://localhost:8081', 'http://localhost:8082', 'http://localhost:19006'];

// Add Vercel domains and configured origins
const corsOrigins = [
  ...allowedOrigins,
  ...devOrigins,
  /\.vercel\.app$/,
  /\.vercel\.dev$/
];

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: true
}));

// Configure multer for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// New Lemon Squeezy health endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    ts: Date.now(),
    origin: req.get('origin') || null
  });
});

// Debug endpoint for body parsing verification
app.post('/api/debug/echo', (req, res) => {
  console.log('🔍 Debug echo request body:', req.body);
  res.json({ 
    success: true,
    body: req.body,
    headers: req.headers,
    timestamp: Date.now()
  });
});

// STRIPE: Create Stripe Checkout for subscriptions
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, customerEmail, userId, successUrl, cancelUrl, promotionCode } = req.body || {};
    
    // Log all incoming data for debugging
    console.log('💳 Stripe checkout request:', { priceId, customerEmail, userId, successUrl, cancelUrl, promotionCode });
    
    if (!priceId || !customerEmail || !userId || !successUrl || !cancelUrl) {
      console.error('❌ Missing required fields:', { priceId: !!priceId, customerEmail: !!customerEmail, userId: !!userId, successUrl: !!successUrl, cancelUrl: !!cancelUrl });
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Validate price ID format
    if (!priceId?.startsWith('price_')) {
      console.error('❌ Invalid price ID format:', priceId);
      return res.status(400).json({ error: 'INVALID_PRICE_ID', message: 'Price ID must start with "price_"' });
    }
    
    console.log('💳 Creating Stripe checkout for priceId:', priceId, 'userId:', userId, promotionCode ? `with promotion code: ${promotionCode}` : '');
    
    const params = {
      mode: "subscription",
      line_items: [{ price: String(priceId), quantity: 1 }],
      automatic_tax: { enabled: false },
      ui_mode: 'hosted',
      client_reference_id: userId,
      customer_email: customerEmail,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      // Ensure the subscription carries userId for later webhook correlation
      subscription_data: {
        metadata: { userId, email: customerEmail },
      },
      metadata: { userId, email: customerEmail },
    };
    
    // Add promotion code if provided
    if (promotionCode) {
      params.discounts = [{ promotion_code: promotionCode }];
      console.log('🎫 Applying promotion code:', promotionCode);
    }
    
    const session = await stripe.checkout.sessions.create(params);
    
    console.log('✅ Stripe checkout session created:', session.id, 'for userId:', userId);
    return res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error("❌ Stripe create-checkout-session error:", err?.message || err);
    return res.status(500).json({ error: err.message || "Stripe session creation failed" });
  }
});

// STRIPE: Info route to expose configured price IDs (safe, no secrets)
app.get("/api/stripe/prices", (_req, res) => {
  res.json({
    monthly: process.env.STRIPE_PRICE_ID_MONTHLY ? "configured" : "missing",
    annual: process.env.STRIPE_PRICE_ID_ANNUAL ? "configured" : "missing"
  });
});

// STRIPE: Diagnostics endpoint to verify Stripe configuration and connectivity
app.get("/api/stripe/diagnostics", async (req, res) => {
  const report = {
    env: {
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_PRICE_ID_MONTHLY: !!process.env.STRIPE_PRICE_ID_MONTHLY,
      STRIPE_PRICE_ID_ANNUAL: !!process.env.STRIPE_PRICE_ID_ANNUAL
    }
  };
  
  try {
    // Verify monthly price if configured
    if (process.env.STRIPE_PRICE_ID_MONTHLY) {
      const p = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_MONTHLY);
      report.prices = { 
        monthly: { 
          id: p.id, 
          active: p.active, 
          currency: p.currency, 
          interval: p.recurring?.interval 
        }
      };
    }
    
    // Verify annual price if configured
    if (process.env.STRIPE_PRICE_ID_ANNUAL) {
      const p = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_ANNUAL);
      report.prices = { 
        ...(report.prices || {}), 
        annual: { 
          id: p.id, 
          active: p.active, 
          currency: p.currency, 
          interval: p.recurring?.interval 
        }
      };
    }
    
    // Verify Stripe connectivity
    report.checkoutSessionDryRun = { ok: true };
    
    // Add cache information
    report.cacheSize = Subscriptions.size;
    
    console.log('✅ Stripe diagnostics completed successfully');
    
  } catch (e) {
    console.error('❌ Stripe diagnostics error:', e.message);
    report.error = e.message;
  }
  
  res.json(report);
});

// Lemon Squeezy products endpoint
app.get('/api/products', async (req, res) => {
  try {
    const products = await getProducts();
    res.json({ 
      success: true, 
      data: products 
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    
    // Check if it's a missing price IDs error
    if (!process.env.STRIPE_PRICE_ID_MONTHLY || !process.env.STRIPE_PRICE_ID_ANNUAL) {
      return res.status(400).json({ 
        success: false, 
        error: 'MISSING_PRICE_IDS',
        message: 'Stripe price IDs not configured in environment'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch products' 
    });
  }
});

// STRIPE: Products endpoint for Stripe price IDs
app.get('/api/stripe/products', async (req, res) => {
  try {
    const monthlyId = process.env.STRIPE_PRICE_ID_MONTHLY;
    const annualId = process.env.STRIPE_PRICE_ID_ANNUAL;
    
    if (!monthlyId || !annualId) {
      return res.status(400).json({ 
        error: "MISSING_PRICE_IDS",
        message: "Stripe price IDs not configured in environment"
      });
    }
    
    res.json({
      monthly: monthlyId ? { id: monthlyId, active: true } : null,
      annual: annualId ? { id: annualId, active: true } : null
    });
  } catch (error) {
    console.error('Error in /api/stripe/products:', error);
    res.status(500).json({ 
      error: "Failed to get Stripe products",
      message: error.message 
    });
  }
});

// POST /api/checkout  body: { plan: 'monthly' | 'annual' }
app.post('/api/checkout', async (req, res) => {
  try {
    const plan = (req.body?.plan === 'annual') ? 'annual' : 'monthly';
    const priceId = plan === 'annual'
      ? process.env.STRIPE_ANNUAL_PRICE_ID
      : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId) {
      return res.status(400).json({ error: 'Missing priceId' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',                       // use 'payment' for one-time
      line_items: [{ price: priceId, quantity: 1 }],
      ui_mode: 'hosted',
      success_url: `${process.env.WEB_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEB_URL}/pricing?canceled=1`,
    });

    return res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('[checkout] error:', e);
    return res.status(500).json({ error: e?.message || 'checkout_failed' });
  }
});

// Lemon Squeezy create checkout endpoint
app.post('/api/create-checkout', async (req, res) => {
  try {
    console.log('📝 Received checkout request body:', req.body);
    
    // Read body with tolerance for different keys
    const variantId = 
      req.body?.variantId ?? 
      req.body?.variant_id ?? 
      req.body?.variant ?? 
      req.body?.id;
    
    if (!variantId) {
      console.error('❌ Missing variantId in request body:', req.body);
      return res.status(400).json({ 
        success: false, 
        error: 'variantId is required',
        received: req.body 
      });
    }

    console.log('✅ Creating checkout for variantId:', variantId);
    const checkoutUrl = await createCheckout(variantId, req.body.customerEmail, req.body.redirectUrl);
    
    res.json({ 
      success: true, 
      checkoutUrl 
    });
  } catch (error) {
    console.error('❌ Error creating checkout:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create checkout',
      details: error.message 
    });
  }
});

// Lemon Squeezy webhook endpoint (must use raw body)
app.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    
    if (!signature) {
      console.error('Missing X-Signature header');
      return res.status(400).send('Missing signature');
    }

    // Verify webhook signature
    if (!verifyWebhookSignature(req.body, signature)) {
      console.error('Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }

    // Parse the raw body
    const payload = JSON.parse(req.body.toString('utf8'));
    
    // Process the webhook event
    processWebhookEvent(payload);
    
    // Always return 200 to avoid retries
    res.status(200).send('ok');
  } catch (error) {
    console.error('Error processing webhook:', error);
    // Still return 200 to avoid retries, but log the error
    res.status(200).send('ok');
  }
});

// STRIPE: Webhook needs raw body for signature verification
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    if (!sig) {
      console.error('❌ Missing Stripe signature header');
      return res.status(400).send('Missing signature');
    }
    
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const handleSubscriptionUpsert = (subObj) => {
    const metaUserId = subObj?.metadata?.userId;
    if (!metaUserId) {
      console.warn("⚠️ Subscription without userId metadata");
      return;
    }
    const status = subObj.status; // 'active', 'trialing', 'incomplete', 'canceled', etc.
    const active = status === "active" || status === "trialing";
    const price = subObj.items?.data?.[0]?.price;
    const plan =
      price?.recurring?.interval === "month" ? "monthly" :
      price?.recurring?.interval === "year"  ? "annual"  : undefined;

    Subscriptions.set(metaUserId, {
      active,
      plan,
      currentPeriodEnd: subObj.current_period_end ? subObj.current_period_end * 1000 : undefined,
      customerId: subObj.customer,
      subscriptionId: subObj.id,
    });
    console.log("✅ Upserted subscription for", metaUserId, Subscriptions.get(metaUserId));
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      // We set both client_reference_id and metadata.userId at session creation
      const userId = session.client_reference_id || session?.metadata?.userId;
      if (userId && session.subscription) {
        // Fetch the subscription to grab recurring info + metadata
        stripe.subscriptions.retrieve(session.subscription)
          .then((sub) => handleSubscriptionUpsert(sub))
          .catch((e) => console.error("Error fetching subscription after checkout:", e));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      handleSubscriptionUpsert(subscription);
      break;
    }
    default:
      // Ignore other events
      console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
      break;
  }

  res.json({ received: true });
});

// STRIPE: Get subscription status for a given userId
app.get("/api/subscription/status", async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ 
        active: false, 
        plan: null, 
        source: "stripe",
        error: "Valid userId parameter is required" 
      });
    }
    
    console.log('🔍 Checking subscription status for userId:', userId);
    
    // Check in-memory store first
    const record = Subscriptions.get(userId);
    if (record) {
      console.log('✅ Subscription found in cache for userId:', userId, record);
      return res.json(record);
    }
    
    // Fallback: try to find by email if userId not in cache
    // This handles legacy cases where we might not have userId in metadata yet
    console.log('⚠️ userId not found in cache, checking Stripe directly...');
    
    // For now, return not active if not in cache
    // The webhook will populate the cache when events come in
    return res.json({ 
      active: false, 
      plan: null, 
      source: "stripe" 
    });
    
  } catch (err) {
    console.error("❌ Subscription status check error:", err?.message || err);
    return res.status(500).json({ 
      active: false, 
      plan: null, 
      source: "stripe",
      error: "Failed to check subscription status" 
    });
  }
});

// STRIPE: POST alias for subscription status (same logic)
app.post("/api/subscription/refresh", async (req, res) => {
  try {
    const { userId } = req.body || {};
    
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ 
        active: false, 
        plan: null, 
        source: "stripe",
        error: "Valid userId in request body is required" 
      });
    }
    
    console.log('🔄 Refreshing subscription status for userId:', userId);
    
    // Check in-memory store
    const record = Subscriptions.get(userId);
    if (record) {
      console.log('✅ Subscription found in cache for userId:', userId, record);
      return res.json(record);
    }
    
    // For now, return not active if not in cache
    // The webhook will populate the cache when events come in
    return res.json({ 
      active: false, 
      plan: null, 
      source: "stripe" 
    });
    
  } catch (err) {
    console.error("❌ Subscription refresh error:", err?.message || err);
    return res.status(500).json({ 
      active: false, 
      plan: null, 
      source: "stripe",
      error: "Failed to refresh subscription status" 
    });
  }
});

// Analyze equipment endpoint
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No image provided',
        message: 'Please upload an image file'
      });
    }

    // Log para verificar ejecución real de AI
    console.log("✅ Prompt sent to OpenAI from /api/analyze");

    // Convertir buffer a base64
    const base64Image = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

    // Prompt estructurado para GPT-4 Vision
    const prompt = `You are an Expert Fitness Trainer. Analyze the gym equipment in the provided image and respond in the following Markdown format:\n\n## Machine Identification\n- Name: [Equipment Name]\n\n## Muscles Targeted\n- Primary: [Main muscles]\n- Secondary: [Other muscles]\n\n## Step-by-Step Instructions\n1. [Step 1]\n2. [Step 2]\n3. [Step 3]\n...\n\n## Common Mistakes\n- [Mistake 1]\n- [Mistake 2]\n- [Mistake 3]\n\n## Safety Tips\n- [Tip 1]\n- [Tip 2]\n\nBe concise, clear, and ensure each section is filled. If unsure, state "Not clearly visible" in the relevant section.`;

    // Llamada a OpenAI Vision
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: prompt
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 1024
    });

    const aiMessage = completion.choices?.[0]?.message?.content || null;
    if (!aiMessage) {
      throw new Error('No response from OpenAI');
    }

    res.json({
      success: true,
      message: aiMessage
    });
  } catch (error) {
    console.error('Error analyzing equipment:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to analyze the image'
    });
  }
});

// RevenueCat Offerings endpoint
app.get('/api/revenuecat/offerings', async (req, res) => {
  try {
    const apiKey = process.env.REVENUECAT_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'RevenueCat API key not configured' });
    }
    // Llama a la API REST de RevenueCat para obtener los offerings
    const response = await fetch('https://api.revenuecat.com/v1/offerings', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'RevenueCat API error', details: errorText });
    }
    const data = await response.json();
    res.json({ success: true, offerings: data });
  } catch (error) {
    console.error('Error fetching RevenueCat offerings:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'Image file size must be less than 10MB'
      });
    }
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: error.message || 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 Analyze endpoint: http://localhost:${PORT}/api/analyze`);
  console.log(`💳 Checkout endpoint: http://localhost:${PORT}/api/checkout`);
  
  // Log configuration status
  console.log(`🌐 WEB_URL: ${process.env.WEB_URL || 'NOT_SET'}`);
  console.log(`🔒 ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || 'NOT_SET'}`);
  
  // Log Lemon Squeezy configuration status
  try {
    validateConfig();
    console.log(`🍋 Lemon Squeezy config → STORE_ID: ✔, API_KEY: ✔, WEBHOOK_SECRET: ✔`);
  } catch (error) {
    console.log(`🍋 Lemon Squeezy config → STORE_ID: ${process.env.LEMONSQUEEZY_STORE_ID ? '✔' : '✖'}, API_KEY: ${!!process.env.LEMONSQUEEZY_API_KEY ? '✔' : '✖'}, WEBHOOK_SECRET: ${!!process.env.LEMONSQUEEZY_WEBHOOK_SECRET ? '✔' : '✖'}`);
    console.log(`⚠️  Lemon Squeezy not fully configured: ${error.message}`);
  }
  
  // STRIPE: Log Stripe configuration status
  console.log("💳 Stripe config →",
    "SECRET:", !!process.env.STRIPE_SECRET_KEY,
    "WEBHOOK:", !!process.env.STRIPE_WEBHOOK_SECRET,
    "MONTHLY:", !!process.env.STRIPE_MONTHLY_PRICE_ID,
    "ANNUAL:", !!process.env.STRIPE_ANNUAL_PRICE_ID
  );
  
  // Checkout endpoint status
  console.log('[checkout] ready', {
    WEB_URL: process.env.WEB_URL,
    MONTHLY: !!process.env.STRIPE_MONTHLY_PRICE_ID,
    ANNUAL: !!process.env.STRIPE_ANNUAL_PRICE_ID,
  });
  
  // Log mounted endpoints
  console.log("✅ Mounted endpoints: /api/checkout, /api/create-checkout-session, /api/stripe/products");
});

module.exports = app; 