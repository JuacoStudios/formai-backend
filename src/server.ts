import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { OpenAI } from 'openai';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

// Validate required environment variables
const required = ['DATABASE_URL', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`[config] Missing env: ${k}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const prisma = new PrismaClient();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil'
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Trust proxy for secure cookies behind Render/NGINX
app.set('trust proxy', 1);

// CORS configuration for Vercel domains
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      /^https:\/\/formai-[a-z0-9\-]*\.vercel\.app$/,
      /^http:\/\/localhost:3000$/,
      /^http:\/\/localhost:3001$/
    ];
    
    if (!origin || allowedOrigins.some(regex => regex.test(origin))) {
      callback(null, true);
        } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Middleware
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.disable('x-powered-by');

// Multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

// Device ID middleware
async function ensureDeviceId(req: any, res: any, next: any) {
  let deviceId = req.cookies['fa_device'];
  const isProd = process.env.NODE_ENV === 'production';

  if (!deviceId) {
    deviceId = uuidv4();
    res.cookie('fa_device', deviceId, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    });
  }
  
  // Upsert device in database
  try {
    await prisma.device.upsert({
      where: { id: deviceId },
      update: { lastSeen: new Date() },
      create: { id: deviceId, lastSeen: new Date() }
    });
  } catch (error) {
    console.error('Error upserting device:', error);
  }
  
  req.deviceId = deviceId;
  next();
}

// Apply device ID middleware to API routes
app.use('/api', ensureDeviceId);

// Health check endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database health check
app.get('/api/health/db', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ status: 'error', error: 'Database connection failed' });
  }
});

// User status endpoint
app.get('/api/me', async (req: any, res) => {
  try {
    const deviceId = req.deviceId;
    
    // Get device with subscription
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        subscriptions: {
          where: {
            status: 'active',
            currentPeriodEnd: { gt: new Date() }
          },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const isPremium = device.subscriptions.length > 0;
    const subscription = device.subscriptions[0];

    return res.json({
      userId: deviceId,
      isPremium,
      subscription: subscription ? {
        status: subscription.status,
        plan: subscription.plan,
        currentPeriodEnd: subscription.currentPeriodEnd
      } : null,
      scansUsed: device.scansUsed || 0,
      scansLimit: isPremium ? -1 : 1 // -1 means unlimited
    });
  } catch (error) {
    console.error('Error getting user status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Analyze endpoint with gating
app.post('/api/analyze', upload.single('image'), async (req: any, res) => {
  try {
    const deviceId = req.deviceId;
    
    // Check if device can scan
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        subscriptions: {
          where: {
            status: 'active',
            currentPeriodEnd: { gt: new Date() }
          }
        }
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const isPremium = device.subscriptions.length > 0;
    const scansUsed = device.scansUsed || 0;
    const scansLimit = isPremium ? -1 : 1;

    // Check gating
    if (!isPremium && scansUsed >= scansLimit) {
      return res.status(403).json({
        error: 'LIMIT_REACHED',
        message: 'Free scan limit reached. Please upgrade to Premium.',
        scansUsed,
        scansLimit
      });
    }

    // Get image
    const file = req.file;
    const base64Image = req.body.image;

    if (!file && !base64Image) {
      return res.status(400).json({
        error: 'NO_IMAGE',
        message: 'No image provided'
      });
    }

    // Convert to base64 if needed
    let imageBase64: string;
    if (file) {
      imageBase64 = file.buffer.toString('base64');
    } else {
      imageBase64 = base64Image;
    }

    const dataUrl = `data:image/jpeg;base64,${imageBase64}`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are an expert fitness trainer. Analyze gym equipment and provide clear, actionable guidance.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What gym equipment is shown in this image? Provide a brief, clear explanation of how to use it properly. Keep the response concise and focused on proper form and usage.'
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
      max_tokens: 300
    });

    const explanation = completion.choices[0]?.message?.content;
    if (!explanation) {
      throw new Error('No response from OpenAI');
    }

    // Increment scan count for non-premium users
    if (!isPremium) {
      await prisma.device.update({
        where: { id: deviceId },
        data: { scansUsed: { increment: 1 } }
      });
    }
    
    return res.json({
      success: true,
      explanation,
      isPremium,
      scansUsed: isPremium ? -1 : scansUsed + 1,
      scansLimit
    });

  } catch (error) {
    console.error('Error in analyze endpoint:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to analyze image'
    });
  }
});

// Stripe checkout endpoint
app.post('/api/stripe/checkout', async (req: any, res) => {
  try {
    const schema = z.object({
      plan: z.enum(['monthly', 'annual'])
    });
    
    const { plan } = schema.parse(req.body);
    const deviceId = req.deviceId;
    
    const priceId = plan === 'annual' 
      ? process.env.STRIPE_PRICE_ID_ANNUAL 
      : process.env.STRIPE_PRICE_ID_MONTHLY;
    
    if (!priceId) {
      return res.status(400).json({ 
        error: 'Price ID not configured',
        plan
      });
    }
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: deviceId,
      success_url: `${process.env.WEB_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEB_URL}/pricing?canceled=1`,
      allow_promotion_codes: true,
      metadata: {
        deviceId,
        plan
      }
    });
    
    return res.json({ url: session.url });
    
  } catch (error) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({
      error: 'Failed to create checkout session'
    });
  }
});

// Stripe webhook
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    if (!sig) {
      return res.status(400).send('Missing signature');
    }
    
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
    
    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const deviceId = session.client_reference_id;
        
        if (deviceId && session.mode === 'subscription' && session.subscription) {
          const subId = session.subscription as string;
          const sub = await stripe.subscriptions.retrieve(subId);
          
          await prisma.subscription.upsert({
            where: { providerSubscriptionId: sub.id },
            update: {
              status: sub.status,
              currentPeriodEnd: new Date((sub as any).current_period_end * 1000),
              plan: sub.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly'
            },
            create: {
              deviceId,
              provider: 'stripe',
              providerCustomerId: String(session.customer),
              providerSubscriptionId: sub.id,
              status: sub.status,
              currentPeriodEnd: new Date((sub as any).current_period_end * 1000),
              plan: sub.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly'
            }
          });
          
          console.log(`✅ Created subscription for device ${deviceId}`);
        }
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await prisma.subscription.updateMany({
          where: { providerSubscriptionId: subscription.id },
          data: {
            status: subscription.status,
            currentPeriodEnd: new Date((subscription as any).current_period_end * 1000)
          }
        });
        
        console.log(`✅ Updated subscription ${subscription.id}`);
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await prisma.subscription.updateMany({
          where: { providerSubscriptionId: subscription.id },
          data: { status: 'canceled' }
        });
        
        console.log(`✅ Canceled subscription ${subscription.id}`);
        break;
      }
    }
    
    return res.status(200).send('ok');
    
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(400).send('Webhook error');
  }
});

// Error handling middleware
app.use((error: any, req: any, res: any, next: any) => {
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
  console.log(`💳 Stripe checkout: http://localhost:${PORT}/api/stripe/checkout`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/api/stripe/webhook`);
});

export default app;