require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { OpenAI } = require('openai');
const { 
  getProducts, 
  createCheckout, 
  verifyWebhookSignature, 
  processWebhookEvent,
  validateConfig 
} = require('./lemonsqueezy');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
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
    const { variantId, customerEmail, redirectUrl } = req.body;
    
    if (!variantId) {
      return res.status(400).json({ 
        success: false, 
        error: 'variantId is required' 
      });
    }

    const checkoutUrl = await createCheckout(variantId, customerEmail, redirectUrl);
    
    res.json({ 
      success: true, 
      checkoutUrl 
    });
  } catch (error) {
    console.error('Error creating checkout:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create checkout' 
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
});

module.exports = app; 