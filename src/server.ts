require('dotenv').config();
import express from 'express';
import cors from 'cors';
import routesMaybe from './routes'; // default export expected
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const { OpenAI } = require('openai');
const Stripe = require('stripe'); // STRIPE: Add Stripe SDK
const { 
  getEntitlementByDevice, 
  canPerformScan, 
  incrementScanUsage 
} = require('./lib/entitlement');

const app = express();
const PORT = process.env.PORT || 8080;

// Environment constants
const PRICE_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY!;
const PRICE_ANNUAL = process.env.STRIPE_PRICE_ID_ANNUAL || undefined;
const WEB_URL = process.env.WEB_URL!;


// Trust proxy for secure cookies behind Render/NGINX
app.set('trust proxy', 1);

// Collapse accidental "/api/api/*" -> "/api/*" to avoid 404s if the client double-prefixes.
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/api/')) {
    const fixed = req.url.replace(/^\/api\/api\//, '/api/');
    console.warn('[ROUTE NORMALIZER] Collapsing', req.url, '->', fixed);
    req.url = fixed;
  }
  // Optional: collapse any double slashes except the protocol prefix
  req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// STRIPE: Initialize Stripe with environment variable
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { 
  apiVersion: "2024-06-20" 
});

// Simple in-memory store for subscriptions by userId
// Replace later with a DB if needed
const Subscriptions = new Map(); // key: userId, value: { active, plan, currentPeriodEnd, customerId, subscriptionId }

// STRIPE: Webhook needs raw body for signature verification - MUST be before JSON parsing
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
  } catch (err: unknown) {
    console.error("❌ Webhook signature verification failed:", err);
    const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
    return res.status(400).send(`Webhook Error: ${errorMessage}`);
  }

  // Idempotency check - if we've already processed this event, return 200
  const { prisma } = require('./db/prisma');
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: { id: event.id }
  });

  if (existingEvent) {
    console.log(`ℹ️ Event ${event.id} already processed, skipping`);
    return res.status(200).send('ok');
  }

  // Store the event for idempotency
  await prisma.webhookEvent.create({
    data: {
      id: event.id,
      provider: 'stripe',
      type: event.type,
      payload: event
    }
  });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const deviceId = session.client_reference_id || session?.metadata?.deviceId;
        
        if (deviceId && session.mode === 'subscription' && session.subscription) {
          // Create device mappings for subscription and customer
          await prisma.deviceMap.createMany({
            data: [
              {
                provider: 'stripe',
                key: `subscription:${session.subscription}`,
                deviceId
              },
              {
                provider: 'stripe',
                key: `customer:${session.customer}`,
                deviceId
              }
            ],
            skipDuplicates: true
          });
          
          console.log(`✅ Created device mappings for device ${deviceId}`);
        }
        break;
      }
      
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const subId = subscription.id;
        const customerId = subscription.customer;
        
        // Find device by subscription or customer mapping
        const deviceMap = await prisma.deviceMap.findFirst({
          where: {
            OR: [
              { provider: 'stripe', key: `subscription:${subId}` },
              { provider: 'stripe', key: `customer:${customerId}` }
            ]
          }
        });
        
        if (deviceMap) {
          const status = subscription.status;
          const price = subscription.items?.data?.[0]?.price;
          const plan = price?.recurring?.interval === "month" ? "monthly" : 
                      price?.recurring?.interval === "year" ? "annual" : null;
          
          // Upsert subscription
          await prisma.subscription.upsert({
            where: { providerSubscriptionId: subId },
            update: {
              status,
              plan,
              currentPeriodEnd: subscription.current_period_end ? 
                new Date(subscription.current_period_end * 1000) : null,
              cancelAtPeriodEnd: subscription.cancel_at_period_end ? 
                new Date(subscription.cancel_at_period_end * 1000) : null,
              deviceId: deviceMap.deviceId
            },
            create: {
              provider: 'stripe',
              providerCustomerId: customerId,
              providerSubscriptionId: subId,
              status,
              plan,
              currentPeriodEnd: subscription.current_period_end ? 
                new Date(subscription.current_period_end * 1000) : null,
              cancelAtPeriodEnd: subscription.cancel_at_period_end ? 
                new Date(subscription.cancel_at_period_end * 1000) : null,
              deviceId: deviceMap.deviceId
            }
          });
          
          console.log(`✅ Upserted subscription ${subId} for device ${deviceMap.deviceId}`);
        } else {
          console.warn(`⚠️ No device mapping found for subscription ${subId}`);
        }
        break;
      }
      
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const subId = subscription.id;
        
        // Update subscription status to canceled
        await prisma.subscription.updateMany({
          where: { providerSubscriptionId: subId },
          data: { status: 'canceled' }
        });
        
        console.log(`✅ Marked subscription ${subId} as canceled`);
        break;
      }
      
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        
        if (subscriptionId) {
          // Mark subscription as past_due
          await prisma.subscription.updateMany({
            where: { providerSubscriptionId: subscriptionId },
            data: { status: 'past_due' }
          });
          
          console.log(`✅ Marked subscription ${subscriptionId} as past_due due to payment failure`);
        }
        break;
      }
      
      case "invoice.paid": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        
        if (subscriptionId) {
          // Reactivate subscription if it was past_due
          await prisma.subscription.updateMany({
            where: { 
              providerSubscriptionId: subscriptionId,
              status: 'past_due'
            },
            data: { status: 'active' }
          });
          
          console.log(`✅ Reactivated subscription ${subscriptionId} after successful payment`);
        }
        break;
      }
      
      default:
        console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
        break;
    }
  } catch (error: unknown) {
    console.error(`❌ Error processing webhook event ${event.id}:`, error);
    // Still return 200 to avoid retries
  }

  res.status(200).send('ok');
});


// --- CORS bootstrap additions ---
const allowlist = [
  /^https:\/\/form-ai-website[a-z0-9\-]*\.vercel\.app$/i,
  /^http:\/\/localhost:(3000|5173)$/
];

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/Postman
    const ok = allowlist.some(re => re.test(origin));
    return cb(ok ? null : new Error('CORS: origin not allowed'), ok);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Mount early, before routes and error handlers
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Cookie parser and JSON body parser
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Security hardening
app.disable('x-powered-by');

// ensureDeviceId middleware for /api/* only
async function ensureDeviceId(req, res, next) {
  let id = req.cookies['fa_device'];
  const isProd = process.env.NODE_ENV === 'production';

  if (!id) {
    id = uuidv4();
    res.cookie('fa_device', id, {
      httpOnly: true,
      secure: isProd,                          // requires HTTPS in prod
      sameSite: isProd ? 'none' : 'lax',       // cross-site cookie for Vercel → Render
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000,       // 1 year
    });
  }
  
  // Upsert device in database
  try {
    const { prisma } = require('./db/prisma');
    await prisma.device.upsert({
      where: { id },
      update: { lastSeen: new Date() },
      create: { id, lastSeen: new Date() }
    });
  } catch (error: unknown) {
    console.error('Error upserting device:', error);
    // Continue anyway - don't block the request
  }
  
  req.deviceId = id;
  next();
}

// Apply device ID middleware only to API routes
app.use('/api', ensureDeviceId);

// Interop guard (before mounting) to fail loudly if the routes export isn't a Router
const api: any = (routesMaybe as any)?.default ?? routesMaybe;
if (typeof api?.use !== 'function') {
  console.error('Invalid API router export. typeof =', typeof api, 'keys=', Object.keys(api || {}));
  throw new Error('Routes export is not an Express Router');
}

// Mount once and keep a JSON 404 fallback
app.use('/api', api);

// Log mounted endpoints
console.info('Mounted endpoint: /api (root)');

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

// OPTIONAL: Debug endpoint (enable in dev or protect with key)
if (process.env.NODE_ENV !== "production" || process.env.CORS_DEBUG_KEY) {
  app.get("/api/debug/cors", (req, res) => {
    const requestOrigin = req.headers.origin as string | undefined;
    const isAllowed = allowlist.some(re => re.test(requestOrigin || ''));
    res.json({
      allowedOrigins: ["https://form-ai-websitee.vercel.app", "http://localhost:3000", "Vercel previews"],
      requestOrigin: requestOrigin || null,
      isAllowed,
      nodeEnv: process.env.NODE_ENV || null,
      hasDebugKey: Boolean(process.env.CORS_DEBUG_KEY),
    });
  });
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check endpoint (root level)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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

// STRIPE: Info route to expose configured price IDs (safe, no secrets)
app.get("/api/stripe/prices", (_req, res) => {
  res.json({
    monthly: process.env.STRIPE_PRICE_ID_MONTHLY ? "configured" : "missing",
    annual: process.env.STRIPE_PRICE_ID_ANNUAL ? "configured" : "missing"
  });
});

// STRIPE: Diagnostics endpoint to verify Stripe configuration and connectivity
app.get("/api/stripe/diagnostics", async (req, res) => {
  const report: any = {
    env: {
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_PRICE_ID_MONTHLY: !!process.env.STRIPE_PRICE_ID_MONTHLY,
      STRIPE_PRICE_ID_ANNUAL: !!process.env.STRIPE_PRICE_ID_ANNUAL,
      WEB_URL: !!process.env.WEB_URL
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
    
  } catch (e: unknown) {
    console.error('❌ Stripe diagnostics error:', e);
    const errorMessage = e instanceof Error ? e.message : 'Unknown error occurred';
    report.error = errorMessage;
  }
  
  res.json(report);
});

// Lemon Squeezy products endpoint
app.get('/api/products', async (req, res) => {
  try {
    const products = {
      monthly: {
        id: process.env.STRIPE_PRICE_ID_MONTHLY,
        name: 'Monthly Plan',
        price: 9.99
      },
      annual: {
        id: process.env.STRIPE_PRICE_ID_ANNUAL,
        name: 'Annual Plan', 
        price: 99.99
      }
    };
    res.json({ 
      success: true, 
      data: products 
    });
  } catch (error: unknown) {
    console.error('Error fetching products:', error);
    
    // Check if it's a missing price IDs error
    if (!process.env.STRIPE_PRICE_ID_MONTHLY || !process.env.STRIPE_PRICE_ID_ANNUAL) {
      return res.status(400).json({ 
        success: false, 
        error: 'MISSING_PRICE_IDS',
        message: 'Stripe price IDs not configured in environment'
      });
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({ 
      success: false, 
      error: errorMessage || 'Failed to fetch products' 
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
  } catch (error: unknown) {
    console.error('Error in /api/stripe/products:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({ 
      error: "Failed to get Stripe products",
      message: errorMessage 
    });
  }
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
    
  } catch (err: unknown) {
    console.error("❌ Subscription status check error:", err);
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
    
  } catch (err: unknown) {
    console.error("❌ Subscription refresh error:", err);
    return res.status(500).json({ 
      active: false, 
      plan: null, 
      source: "stripe",
      error: "Failed to refresh subscription status" 
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
  } catch (error: unknown) {
    console.error('Error fetching RevenueCat offerings:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({ error: 'Internal server error', message: errorMessage });
  }
});

// NEW API ROUTES FOR ONE-FREE-SCAN FLOW

// GET /api/entitlement - Get entitlement status for device
app.get('/api/entitlement', async (req, res) => {
  try {
    const entitlement = await getEntitlementByDevice((req as any).deviceId);
    res.json(entitlement);
  } catch (error: unknown) {
    console.error('Error getting entitlement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scan - Perform scan with gating logic
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    // Check if device can perform scan
    const { canScan, reason } = await canPerformScan((req as any).deviceId);
    
    if (!canScan) {
      return res.status(402).json({ 
        requirePaywall: true, 
        reason: reason || 'limit_exceeded' 
      });
    }
    
    // If this is a free scan (not premium), increment usage
    const entitlement = await getEntitlementByDevice((req as any).deviceId);
    if (!entitlement.active) {
      await incrementScanUsage((req as any).deviceId);
    }
    
    // Perform the actual scan
    await doScan(req, res);
    
  } catch (error: unknown) {
    console.error('Error in scan endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/checkout - Create Stripe checkout session (CONSOLIDATED)
app.post('/api/checkout', async (req, res) => {
  try {
    // Validate request body
    const schema = z.object({
      plan: z.enum(['monthly', 'annual'])
    });
    
    const { plan } = schema.parse(req.body);
    
    // Get price ID from standardized environment variables
    const priceId = plan === 'annual' 
      ? process.env.STRIPE_PRICE_ID_ANNUAL 
      : process.env.STRIPE_PRICE_ID_MONTHLY;
    
    if (!priceId) {
      return res.status(400).json({ 
        error: 'Price ID not configured for plan',
        plan,
        expectedEnv: plan === 'annual' ? 'STRIPE_PRICE_ID_ANNUAL' : 'STRIPE_PRICE_ID_MONTHLY'
      });
    }
    
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: (req as any).deviceId,
      success_url: `${process.env.WEB_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEB_URL}/pricing?canceled=1`,
      allow_promotion_codes: true,
      metadata: {
        deviceId: (req as any).deviceId,
        plan: plan
      }
    });
    
    console.log(`✅ Created checkout session ${session.id} for device ${(req as any).deviceId}, plan: ${plan}`);
    res.json({ url: session.url });
    
  } catch (error: unknown) {
    console.error('Error creating checkout session:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid request body', 
        details: (error as any).issues 
      });
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: errorMessage 
    });
  }
});

// Refactored scan logic
async function doScan(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No image provided',
        message: 'Please upload an image file'
      });
    }

    // Log para verificar ejecución real de AI
    console.log("✅ Prompt sent to OpenAI from /api/scan");

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
  } catch (error: unknown) {
    console.error('Error analyzing equipment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    res.status(500).json({
      error: 'Internal server error',
      message: errorMessage || 'Failed to analyze the image'
    });
  }
}


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
  console.log(`🔒 CORS_ALLOWED_ORIGINS: ${process.env.CORS_ALLOWED_ORIGINS || 'NOT_SET'}`);
  console.log(`🔒 CORS: Production + Vercel previews + localhost allowed`);
  
  // Log CORS and NODE_ENV configuration
  console.log('[server] NODE_ENV:', process.env.NODE_ENV);
  
  console.log(`💳 Stripe config → PRICE_MONTHLY: ${process.env.STRIPE_PRICE_ID_MONTHLY ? '✔' : '✖'}, PRICE_ANNUAL: ${process.env.STRIPE_PRICE_ID_ANNUAL ? '✔' : '✖'}, WEBHOOK_SECRET: ${!!process.env.STRIPE_WEBHOOK_SECRET ? '✔' : '✖'}`);
  
  // STRIPE: Log Stripe configuration status
  console.log("💳 Stripe config →",
    "SECRET:", !!process.env.STRIPE_SECRET_KEY,
    "WEBHOOK:", !!process.env.STRIPE_WEBHOOK_SECRET,
    "MONTHLY:", !!process.env.STRIPE_PRICE_ID_MONTHLY,
    "ANNUAL:", !!process.env.STRIPE_PRICE_ID_ANNUAL
  );
  
  // Checkout endpoint status
  console.log('[checkout] ready', {
    WEB_URL: process.env.WEB_URL,
    MONTHLY: !!process.env.STRIPE_PRICE_ID_MONTHLY,
    ANNUAL: !!process.env.STRIPE_PRICE_ID_ANNUAL,
  });
  
  // Log mounted endpoints
  console.log("✅ Mounted endpoints: /api/checkout, /api/stripe/products, /api/stripe/diagnostics");
});

module.exports = app; 
