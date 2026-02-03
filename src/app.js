const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const socketIo = require('./utils/socket');
const path = require('path');
const fs = require('fs');

// Import middleware
const { errorHandler } = require('./middleware/errorHandler');
const { authMiddleware } = require('./middleware/auth');

// Import routes
const authRoutes = require('./routes/auth');
const requestRoutes = require('./routes/requests');
const eventRoutes = require('./routes/events');
const donationRoutes = require('./routes/donations');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const volunteerRoutes = require('./routes/volunteers');
const announcementRoutes = require('./routes/announcements');
const messageRoutes = require('./routes/messages');
const dashboardRoutes = require('./routes/dashboard');
const emergencyRoutes = require('./routes/emergency');

// Initialize Prisma
const prisma = new PrismaClient();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all requests
app.use(limiter);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'barangaylink-api',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  });
});

// API Documentation
app.get('/api/docs', (req, res) => {
  res.json({
    message: 'BarangayLink API Documentation',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth/*',
      requests: '/api/requests/*',
      events: '/api/events/*',
      donations: '/api/donations/*',
      volunteers: '/api/volunteers/*',
      admin: '/api/admin/*',
      ai: '/api/ai/*',
      announcements: '/api/announcements/*',
      messages: '/api/messages/*',
      dashboard: '/api/dashboard/*',
      emergency: '/api/emergency/*',
    },
    documentation: 'See README.md for detailed API documentation',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/admin', authMiddleware, adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/volunteers', authMiddleware, volunteerRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/messages', authMiddleware, messageRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/emergency', authMiddleware, emergencyRoutes);

// 404 handler for undefined routes
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Global error handler
app.use(errorHandler);

// Prisma error handling middleware
prisma.$use(async (params, next) => {
  const start = Date.now();
  try {
    const result = await next(params);
    const end = Date.now();
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`Query ${params.model}.${params.action} took ${end - start}ms`);
    }
    
    return result;
  } catch (error) {
    console.error(`Prisma error in ${params.model}.${params.action}:`, error);
    throw error;
  }
});

module.exports = { app, prisma };
