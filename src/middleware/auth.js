const jwt = require('jsonwebtoken');
const { prisma } = require('../app');
const logger = require('../utils/logger');

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided or invalid format'
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }
    
    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired'
        });
      }
      
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token'
        });
      }
      
      throw error;
    }
    
    // Check if user still exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        role: true,
        isVerified: true,
        isActive: true
      }
    });
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if user is verified
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email first'
      });
    }
    
    // Check if user is active
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated'
      });
    }
    
    // Attach user to request object
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role
    };
    
    // Log authentication
    logger.debug(`User authenticated: ${decoded.email} (${decoded.role})`);
    
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Role-based access control middleware
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    next();
  };
};

// Optional authentication middleware
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: {
            id: true,
            email: true,
            role: true,
            isVerified: true
          }
        });
        
        if (user && user.isVerified) {
          req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role
          };
        }
      } catch (error) {
        // Token is invalid but that's okay for optional auth
        logger.debug('Optional auth token invalid:', error.message);
      }
    }
    
    next();
  } catch (error) {
    logger.error('Optional auth error:', error);
    next();
  }
};

module.exports = {
  authMiddleware,
  authorize,
  optionalAuth
};
