# Lemon Squeezy Integration Setup

## Environment Variables Required

Add these to your `.env` file or Render environment variables:

```bash
# Lemon Squeezy Configuration
LEMONSQUEEZY_API_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiI4NTcxZmZlMjQ5OGM4OTliNDNiOWYxYTcwZTE2ZDAxNmU2ZGQ3MTJlNWM2MmJhZGZlY2E5NjQxYjlhM2NjNTBmMGVkMzAwYTA4YzY5MmU4ZCIsImlhdCI6MTc1NTk3NTQwNy42NTUxNjMsIm5iZiI6MTc1NTk3NTQwNy42NTUxNjYsImV4cCI6MjA3MTUwODIwNy42MjY1MTMsInN1YiI6IjU0MjUzOTUiLCJzY29wZXMiOltdfQ.mDs-6btHDzbuedxH78MrKiCllevZcqdF5vQsNWPw4Gep0pOm3COyU86qk6ga8YeUxEAOYHFGQuAG92LQ6pN266bQIcfAwvl7AHmYDNkcCLIyuRE47xNUuT5FwBxrgEdHpkqQAGon033D3OdqeXaVfINf_XyNpzfRp1o7_ibWCHnKwfk5oPbxdzoqz_axY_VV6H_kQG7rHjypiqRuCifsIqx250xqPeuEc7g4OY_CauFCfVjJWULqVseRsikw_aK4XJPk2utL8pY5Loixnu9tpuKrXlWP2Lg0Y_0FtC2_eB4ZNZqrzZVEzuaGaVnWEnvHzucpekxq0dE1JWNjN7cYlrES_tK2wF_5i-EwACq7KSmql-IpamT7k-VafTHQ0LGAJzlZ6GgIhhlLpbCL4Ub3Aq1aK0svJHp_3mZB3WQiD44P_GeiLhWmeoqnfA1hLwPXH6aFbxmgLlVlFjcahofabSbg6kG4ek8t13PiybYA3BDy-iTtIv2qTckVvwdUOSOs
LEMONSQUEEZY_STORE_ID=215923
LEMONSQUEEZY_WEBHOOK_SECRET=Millos1307.
```

## Routes Exposed

### Health Check
- **GET** `/api/health` → Returns `{ ok: true, ts: timestamp }`

### Products
- **GET** `/api/products` → Returns array of products with variant IDs
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "product_id",
        "name": "Product Name",
        "description": "Product description",
        "price_formatted": "$10.00",
        "large_thumb_url": "https://...",
        "variantId": "variant_id"
      }
    ]
  }
  ```

### Checkout
- **POST** `/api/create-checkout` → Creates checkout session
  ```json
  // Request
  {
    "variantId": "variant_id",
    "customerEmail": "user@example.com",
    "redirectUrl": "formai://purchase/success"
  }
  
  // Response
  {
    "success": true,
    "checkoutUrl": "https://checkout.lemonsqueezy.com/..."
  }
  ```

### Webhooks
- **POST** `/webhooks/lemonsqueezy` → Handles Lemon Squeezy webhook events
  - Uses raw body parsing for signature verification
  - Supports all subscription and order events
  - Returns `200 OK` to prevent retries

## How to Test Locally

### 1. Start the server
```bash
npm run dev
```

### 2. Test health endpoint
```bash
curl http://localhost:8080/api/health
# Expected: { "ok": true, "ts": 1234567890 }
```

### 3. Test products endpoint
```bash
curl http://localhost:8080/api/products
# Expected: { "success": true, "data": [...] }
```

### 4. Test checkout creation
```bash
curl -X POST http://localhost:8080/api/create-checkout \
  -H "Content-Type: application/json" \
  -d '{"variantId": "your_variant_id"}'
# Expected: { "success": true, "checkoutUrl": "..." }
```

### 5. Test webhooks (requires external access)

#### Option A: Use ngrok to expose local server
```bash
# Install ngrok
npm install -g ngrok

# Expose your local server
ngrok http 8080

# Use the ngrok URL in Lemon Squeezy webhook settings
# Example: https://abc123.ngrok.io/webhooks/lemonsqueezy
```

#### Option B: Use Render's preview URL
- Deploy to Render and use the preview URL
- Set webhook URL to: `https://your-app.onrender.com/webhooks/lemonsqueezy`

### 6. Configure Lemon Squeezy webhook
1. Go to Lemon Squeezy Dashboard → Settings → Webhooks
2. Add new webhook:
   - **URL**: Your ngrok or Render URL + `/webhooks/lemonsqueezy`
   - **Events**: Select all subscription and order events
   - **Signing Secret**: Copy the secret to your `.env` file

### 7. Test complete flow
1. Create a test checkout via `/api/create-checkout`
2. Open the checkout URL in browser
3. Complete a test purchase
4. Check server logs for webhook events
5. Verify webhook returns `200 OK`

## Webhook Events Handled

- `order_created` - New order placed
- `subscription_created` - New subscription started
- `subscription_updated` - Subscription modified
- `subscription_cancelled` - Subscription cancelled
- `subscription_expired` - Subscription expired
- `subscription_payment_success` - Payment successful
- `subscription_payment_failed` - Payment failed

## Database Integration (TODO)

The webhook handler includes TODO comments for database integration:

- **Supabase**: Recommended for user management and subscription tracking
- **User Status**: Mark users as PRO on successful subscription
- **Subscription Tracking**: Store subscription details and status
- **Payment History**: Log payment successes and failures

## Troubleshooting

### Missing environment variables
```
⚠️  Lemon Squeezy not fully configured: Missing required Lemon Squeezy environment variables: LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_WEBHOOK_SECRET
```

### Invalid webhook signature
```
❌ Invalid webhook signature
```
- Verify `LEMONSQUEEZY_WEBHOOK_SECRET` matches the signing secret in Lemon Squeezy
- Ensure webhook URL is correct
- Check that the webhook uses raw body parsing

### API errors
```
🍋 Lemon Squeezy API error: 401 - Unauthorized
```
- Verify `LEMONSQUEEZY_API_KEY` is correct
- Check that the API key has proper permissions
- Ensure `LEMONSQUEEZY_STORE_ID` is valid

## Production Deployment

1. Set environment variables in Render dashboard
2. Deploy the updated code
3. Update webhook URL to production URL
4. Test webhook delivery in production
5. Monitor logs for any errors












