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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    ts: Date.now() 
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
    const { priceId, customerEmail, successUrl, cancelUrl, promotionCode } = req.body || {};
    if (!priceId) return res.status(400).json({ success: false, error: "priceId is required" });
    
    console.log('💳 Creating Stripe checkout for priceId:', priceId, promotionCode ? `with promotion code: ${promotionCode}` : '');
    
    const params = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: String(priceId), quantity: 1 }],
      customer_email: customerEmail,
      success_url: successUrl || "formai://purchase/success",
      cancel_url: cancelUrl || "formai://purchase/cancel",
      allow_promotion_codes: true
    };
    
    // Add promotion code if provided
    if (promotionCode) {
      params.discounts = [{ promotion_code: promotionCode }];
      console.log('🎫 Applying promotion code:', promotionCode);
    }
    
    const session = await stripe.checkout.sessions.create(params);
    
    console.log('✅ Stripe checkout session created:', session.id);
    return res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ Stripe create-checkout-session error:", err?.message || err);
    return res.status(500).json({ success: false, error: "Failed to create checkout session" });
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
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch products' 
    });
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
  
  try {
    if (!sig) {
      console.error('❌ Missing Stripe signature header');
      return res.status(400).send('Missing signature');
    }
    
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    // Handle events relevant to subscriptions
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("✅ checkout.session.completed", session.id, session.customer_email);
        // TODO: mark user PRO in DB using email or metadata
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        console.log("⚠️ invoice.payment_failed", invoice.id, invoice.customer_email);
        // TODO: optionally flag grace period / downgrade
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        console.log("🪓 subscription deleted", sub.id);
        // TODO: downgrade user to FREE
        break;
      }
      default:
        console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
    }
    
    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Stripe webhook error:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || "invalid signature"}`);
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
    "MONTHLY:", !!process.env.STRIPE_PRICE_ID_MONTHLY,
    "ANNUAL:", !!process.env.STRIPE_PRICE_ID_ANNUAL
  );
});

module.exports = app; 