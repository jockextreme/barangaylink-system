const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const { prisma } = require('../app');
const logger = require('./logger');

let io;

const init = (server) => {
  io = socketIo(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });
  
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Verify user exists and is active
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
      
      if (!user || !user.isVerified || user.isActive === false) {
        return next(new Error('Authentication error: Invalid user'));
      }
      
      socket.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role
      };
      
      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(new Error('Authentication error: Invalid token'));
    }
  });
  
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.user.email})`);
    
    // Join user-specific room
    socket.join(`user-${socket.user.id}`);
    
    // Join role-based room
    socket.join(socket.user.role.toLowerCase());
    
    // Join admin room if user is admin/moderator
    if (socket.user.role === 'ADMIN' || socket.user.role === 'MODERATOR') {
      socket.join('admins');
    }
    
    // Handle request room joining
    socket.on('join-request', (requestId) => {
      socket.join(`request-${requestId}`);
      logger.debug(`User ${socket.user.email} joined request room: ${requestId}`);
    });
    
    // Handle chat room joining
    socket.on('join-chat', (chatId) => {
      socket.join(`chat-${chatId}`);
      logger.debug(`User ${socket.user.email} joined chat room: ${chatId}`);
    });
    
    // Handle private messages
    socket.on('private-message', async (data) => {
      try {
        const { to, message, type = 'text' } = data;
        
        // Save message to database
        const savedMessage = await prisma.message.create({
          data: {
            content: message,
            senderId: socket.user.id,
            receiverId: to,
            messageType: type
          }
        });
        
        // Emit to receiver
        io.to(`user-${to}`).emit('private-message', {
          from: socket.user.id,
          message: savedMessage.content,
          type: savedMessage.messageType,
          timestamp: savedMessage.createdAt
        });
        
        logger.info(`Private message sent from ${socket.user.email} to ${to}`);
      } catch (error) {
        logger.error('Error sending private message:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });
    
    // Handle typing indicators
    socket.on('typing', (data) => {
      const { chatId, isTyping } = data;
      socket.to(`chat-${chatId}`).emit('user-typing', {
        userId: socket.user.id,
        isTyping
      });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} (User: ${socket.user.email})`);
    });
    
    // Error handling
    socket.on('error', (error) => {
      logger.error('Socket error:', error);
    });
  });
  
  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

// Helper function to emit notifications
const emitNotification = (userId, notification) => {
  try {
    const io = getIO();
    io.to(`user-${userId}`).emit('notification', notification);
    logger.debug(`Notification emitted to user ${userId}`);
  } catch (error) {
    logger.error('Error emitting notification:', error);
  }
};

// Helper function to broadcast to admins
const broadcastToAdmins = (event, data) => {
  try {
    const io = getIO();
    io.to('admins').emit(event, data);
    logger.debug(`Broadcast to admins: ${event}`);
  } catch (error) {
    logger.error('Error broadcasting to admins:', error);
  }
};

// Helper function to update request status
const updateRequestStatus = (requestId, status) => {
  try {
    const io = getIO();
    io.to(`request-${requestId}`).emit('request-status-updated', {
      requestId,
      status,
      updatedAt: new Date()
    });
    logger.debug(`Request status updated: ${requestId} -> ${status}`);
  } catch (error) {
    logger.error('Error updating request status:', error);
  }
};

module.exports = {
  init,
  getIO,
  emitNotification,
  broadcastToAdmins,
  updateRequestStatus
};
