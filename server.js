const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Analyze equipment endpoint
app.post('/api/analyze', upload.single('image'), (req, res) => {
  try {
    // Check if image was uploaded
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No image provided',
        message: 'Please upload an image file'
      });
    }

    // For now, return a dummy result
    // This will be replaced with real AI analysis later
    const dummyResults = [
      'Treadmill',
      'Weight Bench',
      'Dumbbells',
      'Squat Rack',
      'Elliptical Machine',
      'Rowing Machine',
      'Leg Press',
      'Cable Machine'
    ];

    const randomMachine = dummyResults[Math.floor(Math.random() * dummyResults.length)];

    res.json({
      success: true,
      machine: randomMachine,
      message: `This appears to be a ${randomMachine.toLowerCase()}.`,
      confidence: Math.random() * 0.3 + 0.7, // Random confidence between 0.7 and 1.0
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error analyzing equipment:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to analyze the image'
    });
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
});

module.exports = app; 