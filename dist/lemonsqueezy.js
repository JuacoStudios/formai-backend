const crypto = require('node:crypto');

// Lemon Squeezy API configuration
const LEMONSQUEEZY_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LEMONSQUEEZY_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID;
const LEMONSQUEEZY_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

// Validate required environment variables
function validateConfig() {
  const missing = [];
  if (!LEMONSQUEEZY_API_KEY) missing.push('LEMONSQUEEZY_API_KEY');
  if (!LEMONSQUEEZY_STORE_ID) missing.push('LEMONSQUEEZY_STORE_ID');
  if (!LEMONSQUEEZY_WEBHOOK_SECRET) missing.push('LEMONSQUEEZY_WEBHOOK_SECRET');
  
  if (missing.length > 0) {
    throw new Error(`Missing required Lemon Squeezy environment variables: ${missing.join(', ')}`);
  }
}

// Common headers for Lemon Squeezy API
const getHeaders = () => ({
  'Authorization': `Bearer ${LEMONSQUEEZY_API_KEY}`,
  'Accept': 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json'
});

/**
 * Get products from Lemon Squeezy store
 * @returns {Promise<Array>} Array of products with variants
 */
async function getProducts() {
  try {
    validateConfig();
    
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/products?filter[store_id]=${LEMONSQUEEZY_STORE_ID}&include=variants`,
      {
        method: 'GET',
        headers: getHeaders()
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Lemon Squeezy API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Map the response to our format
    return data.data.map(product => {
      const attributes = product.attributes;
      const variants = product.relationships?.variants?.data || [];
      const firstVariant = variants[0];
      
      return {
        id: product.id,
        name: attributes.name,
        description: attributes.description,
        price_formatted: attributes.price_formatted,
        large_thumb_url: attributes.large_thumb_url,
        variantId: firstVariant?.id || null
      };
    }).filter(product => product.variantId); // Only return products with variants
  } catch (error) {
    console.error('Error fetching Lemon Squeezy products:', error);
    throw error;
  }
}

/**
 * Create a checkout session for a specific variant
 * @param {string} variantId - The variant ID to create checkout for
 * @param {string} customerEmail - Optional customer email
 * @param {string} redirectUrl - Optional redirect URL after purchase
 * @returns {Promise<string>} Checkout URL
 */
async function createCheckout(variantId, customerEmail, redirectUrl = 'formai://purchase/success') {
  try {
    validateConfig();
    
    if (!variantId) {
      throw new Error('Variant ID is required');
    }

    const checkoutData = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: customerEmail || undefined,
            custom: {
              variant_id: variantId
            }
          },
          product_options: {
            redirect_url: redirectUrl
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: LEMONSQUEEZY_STORE_ID
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: variantId
            }
          }
        }
      }
    };

    const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(checkoutData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create checkout: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const checkoutUrl = data.data.attributes.url;
    
    if (!checkoutUrl) {
      throw new Error('No checkout URL received from Lemon Squeezy');
    }

    return checkoutUrl;
  } catch (error) {
    console.error('Error creating Lemon Squeezy checkout:', error);
    throw error;
  }
}

/**
 * Verify webhook signature
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - X-Signature header value
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(rawBody, signature) {
  try {
    if (!LEMONSQUEEZY_WEBHOOK_SECRET) {
      console.error('Webhook secret not configured');
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', LEMONSQUEEZY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    // Timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    console.error('Error verifying webhook signature:', error);
    return false;
  }
}

/**
 * Process webhook events
 * @param {Object} payload - Parsed webhook payload
 */
function processWebhookEvent(payload) {
  try {
    const event = payload?.meta?.event_name;
    const data = payload?.data;
    
    if (!event || !data) {
      console.log('Invalid webhook payload structure');
      return;
    }

    console.log(`🍋 Lemon Squeezy webhook: ${event}`, {
      event,
      dataId: data.id,
      dataType: data.type
    });

    // Handle different event types
    switch (event) {
      case 'order_created':
        console.log('📦 Order created:', data.id);
        // TODO: Persist order to database (Supabase)
        // TODO: Mark user as PRO if this is a subscription product
        break;
        
      case 'subscription_created':
        console.log('✅ Subscription created:', data.id);
        // TODO: Persist subscription to database (Supabase)
        // TODO: Mark user as PRO
        break;
        
      case 'subscription_updated':
        console.log('🔄 Subscription updated:', data.id);
        // TODO: Update subscription in database (Supabase)
        break;
        
      case 'subscription_cancelled':
        console.log('❌ Subscription cancelled:', data.id);
        // TODO: Update subscription status in database (Supabase)
        // TODO: Remove PRO status from user
        break;
        
      case 'subscription_expired':
        console.log('⏰ Subscription expired:', data.id);
        // TODO: Update subscription status in database (Supabase)
        // TODO: Remove PRO status from user
        break;
        
      case 'subscription_payment_success':
        console.log('💳 Subscription payment success:', data.id);
        // TODO: Update subscription in database (Supabase)
        // TODO: Ensure user has PRO status
        break;
        
      case 'subscription_payment_failed':
        console.log('💸 Subscription payment failed:', data.id);
        // TODO: Update subscription status in database (Supabase)
        // TODO: Handle failed payment (maybe send email, remove PRO status)
        break;
        
      default:
        console.log(`ℹ️ Unhandled webhook event: ${event}`);
        break;
    }
  } catch (error) {
    console.error('Error processing webhook event:', error);
  }
}

module.exports = {
  getProducts,
  createCheckout,
  verifyWebhookSignature,
  processWebhookEvent,
  validateConfig
};






