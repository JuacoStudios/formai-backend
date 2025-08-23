# Backend API - Gym Equipment Analysis

A Node.js/Express backend API for analyzing gym equipment from images with Lemon Squeezy subscription integration.

## Features

- Health check endpoint
- Image analysis endpoint using OpenAI Vision API
- File upload handling with validation
- CORS enabled for frontend integration
- **Lemon Squeezy integration** for subscriptions and payments
- Ready for deployment on Render

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

The server will start on `http://localhost:8080`

## Production

```bash
npm start
```

## API Endpoints

### Health Check
- **GET** `/health` → Returns: `{ status: 'ok' }`
- **GET** `/api/health` → Returns: `{ ok: true, ts: timestamp }`

### Analyze Equipment
- **POST** `/api/analyze`
- **Content-Type**: `multipart/form-data`
- **Body**: 
  - `image`: Image file (max 10MB)
- **Returns**:
  ```json
  {
    "success": true,
    "message": "AI analysis result in Markdown format"
  }
  ```

### Lemon Squeezy Integration
- **GET** `/api/products` → Returns available products with variant IDs
- **POST** `/api/create-checkout` → Creates checkout session
- **POST** `/webhooks/lemonsqueezy` → Handles webhook events

### RevenueCat (Legacy)
- **GET** `/api/revenuecat/offerings` → Returns RevenueCat offerings

## Environment Variables

### Required
- `OPENAI_API_KEY`: OpenAI API key for image analysis
- `LEMONSQUEEZY_API_KEY`: Lemon Squeezy API key
- `LEMONSQUEEZY_STORE_ID`: Lemon Squeezy store ID
- `LEMONSQUEEZY_WEBHOOK_SECRET`: Webhook signing secret

### Optional
- `PORT`: Server port (default: 8080)
- `REVENUECAT_API_KEY`: RevenueCat API key (legacy)

## Lemon Squeezy Setup

For detailed Lemon Squeezy configuration and testing instructions, see [LEMON_SQUEEZY_SETUP.md](./LEMON_SQUEEZY_SETUP.md).

### Quick Start
1. Set environment variables in Render dashboard
2. Configure webhook URL: `https://your-app.onrender.com/webhooks/lemonsqueezy`
3. Test endpoints locally or in production

## Deployment

This backend is configured for deployment on Render:

1. Connect your repository to Render
2. Set the build command: `npm install`
3. Set the start command: `npm start`
4. Set all required environment variables
5. Deploy and test webhook delivery

## File Structure

```
backend/
├── server.js                    # Main server file
├── lemonsqueezy.js             # Lemon Squeezy integration module
├── package.json                 # Dependencies and scripts
├── .gitignore                  # Git ignore rules
├── README.md                   # This file
├── LEMON_SQUEEZY_SETUP.md     # Detailed Lemon Squeezy setup
└── render.yaml                 # Render deployment config
```

## Error Handling

The API includes comprehensive error handling for:
- Missing image files
- Invalid file types
- File size limits
- Lemon Squeezy API errors
- Webhook signature verification
- Server errors

## Webhook Events Supported

- `order_created` - New order placed
- `subscription_created` - New subscription started
- `subscription_updated` - Subscription modified
- `subscription_cancelled` - Subscription cancelled
- `subscription_expired` - Subscription expired
- `subscription_payment_success` - Payment successful
- `subscription_payment_failed` - Payment failed

## Future Enhancements

- Database integration (Supabase) for user management
- Subscription status tracking
- Payment history logging
- User authentication
- Rate limiting
- Image preprocessing and caching 