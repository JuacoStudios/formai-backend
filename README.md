# Backend API - Gym Equipment Analysis

A Node.js/Express backend API for analyzing gym equipment from images.

## Features

- Health check endpoint
- Image analysis endpoint (currently returns dummy data)
- File upload handling with validation
- CORS enabled for frontend integration
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
- **GET** `/health`
- Returns: `{ status: 'ok' }`

### Analyze Equipment
- **POST** `/api/analyze`
- **Content-Type**: `multipart/form-data`
- **Body**: 
  - `image`: Image file (max 10MB)
- **Returns**:
  ```json
  {
    "success": true,
    "machine": "Treadmill",
    "message": "This appears to be a treadmill.",
    "confidence": 0.85,
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
  ```

## Environment Variables

- `PORT`: Server port (default: 8080)

## Deployment

This backend is configured for deployment on Render:

1. Connect your repository to Render
2. Set the build command: `npm install`
3. Set the start command: `npm start`
4. Set environment variables as needed

## File Structure

```
backend/
├── server.js          # Main server file
├── package.json       # Dependencies and scripts
├── .gitignore         # Git ignore rules
└── README.md          # This file
```

## Error Handling

The API includes comprehensive error handling for:
- Missing image files
- Invalid file types
- File size limits
- Server errors

## Future Enhancements

- Integrate with OpenAI Vision API for real image analysis
- Add authentication
- Add rate limiting
- Add image preprocessing
- Add result caching 