const { prisma } = require('../app');
const aiService = require('../services/aiService');
const { sendNotification } = require('../utils/notificationService');
const { uploadToCloudinary } = require('../utils/fileUpload');
const logger = require('../utils/logger');

class RequestController {
  // Create new request with AI prioritization
  async createRequest(req, res, next) {
    try {
      const userId = req.user.userId;
      const { title, description, category, location, address, files } = req.body;
      
      // Validate required fields
      if (!title || !description || !category) {
        return res.status(400).json({ 
          success: false, 
          message: 'Title, description, and category are required' 
        });
      }
      
      // Get user for context
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { 
          id: true, 
          firstName: true, 
          lastName: true,
          address: true 
        }
      });
      
      // Get historical context for AI
      const userRequests = await prisma.request.findMany({
        where: { userId },
        take: 10,
        orderBy: { createdAt: 'desc' }
      });
      
      // AI prioritization
      const aiResult = await aiService.prioritizeRequest({
        title,
        description,
        category,
        location: location || user.address,
        historicalContext: {
          total_requests: userRequests.length,
          recent_category: userRequests[0]?.category,
          avg_resolution_time: this.calculateAvgResolution(userRequests)
        }
      });
      
      // Upload files if provided
      let uploadedFiles = [];
      if (files && files.length > 0) {
        for (const file of files) {
          if (file.base64) {
            const uploadResult = await uploadToCloudinary(file.base64, 'requests');
            uploadedFiles.push(uploadResult.secure_url);
          }
        }
      }
      
      // Create request
      const request = await prisma.request.create({
        data: {
          title,
          description,
          category,
          priority: aiResult.priority,
          aiPriorityScore: aiResult.score,
          location: location || user.address,
          address: address || user.address,
          files: uploadedFiles,
          userId,
          status: 'PENDING'
        },
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
              contactNumber: true,
              avatar: true
            }
          }
        }
      });
      
      // Create initial update
      await prisma.requestUpdate.create({
        data: {
          requestId: request.id,
          description: `Request created. AI Priority: ${aiResult.priority} (Score: ${aiResult.score.toFixed(2)})`,
          status: 'PENDING',
          createdById: userId
        }
      });
      
      // Notify moderators/admins
      const moderators = await prisma.user.findMany({
        where: {
          role: { in: ['MODERATOR', 'ADMIN'] },
          isVerified: true
        },
        select: { id: true }
      });
      
      for (const moderator of moderators) {
        await sendNotification({
          userId: moderator.id,
          type: 'REQUEST_UPDATE',
          title: 'New Request Needs Attention',
          message: `New ${category} request: ${title}`,
          link: `/requests/${request.id}`,
          metadata: {
            requestId: request.id,
            priority: aiResult.priority,
            category
          }
        });
      }
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'CREATE_REQUEST',
          entityType: 'REQUEST',
          entityId: request.id,
          details: {
            title,
            category,
            aiPriority: aiResult.priority,
            aiScore: aiResult.score
          }
        }
      });
      
      // Emit real-time notification via Socket.IO
      if (req.io) {
        req.io.to('admins').emit('new-request', {
          requestId: request.id,
          title: request.title,
          category: request.category,
          priority: request.priority,
          createdAt: request.createdAt
        });
      }
      
      logger.info(`Request created: ${request.id} by user: ${userId}`);
      
      res.status(201).json({
        success: true,
        message: 'Request submitted successfully',
        data: {
          ...request,
          aiAnalysis: {
            priority: aiResult.priority,
            score: aiResult.score,
            reason: aiResult.reason
          }
        }
      });
      
    } catch (error) {
      logger.error('Create request error:', error);
      next(error);
    }
  }
  
  // Get requests with filtering and pagination
  async getRequests(req, res, next) {
    try {
      const { 
        page = 1, 
        limit = 20, 
        category, 
        status, 
        priority,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        search,
        userId: filterUserId,
        assignedToId
      } = req.query;
      
      const currentUserId = req.user.userId;
      const userRole = req.user.role;
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      // Build where clause based on user role and filters
      let where = {};
      
      // Regular users can only see their own requests
      if (userRole === 'MEMBER' || userRole === 'VOLUNTEER') {
        where.userId = currentUserId;
      }
      
      // Admins/Moderators can filter by user
      if (filterUserId && (userRole === 'ADMIN' || userRole === 'MODERATOR')) {
        where.userId = filterUserId;
      }
      
      // Apply filters
      if (category) where.category = category;
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (assignedToId) where.assignedToId = assignedToId;
      
      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } }
        ];
      }
      
      // Get total count
      const total = await prisma.request.count({ where });
      
      // Get requests with pagination
      const requests = await prisma.request.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              contactNumber: true
            }
          },
          assignedTo: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true
            }
          },
          updates: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              description: true,
              status: true,
              createdAt: true,
              createdBy: {
                select: {
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        },
        orderBy: {
          [sortBy]: sortOrder
        },
        skip,
        take: parseInt(limit)
      });
      
      // Add AI-suggested actions for admins/moderators
      let enhancedRequests = requests;
      if (userRole === 'ADMIN' || userRole === 'MODERATOR') {
        enhancedRequests = requests.map(request => ({
          ...request,
          aiSuggestions: this.generateAISuggestions(request)
        }));
      }
      
      logger.info(`Retrieved ${requests.length} requests for user: ${currentUserId}`);
      
      res.json({
        success: true,
        data: {
          requests: enhancedRequests,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
      
    } catch (error) {
      logger.error('Get requests error:', error);
      next(error);
    }
  }
  
  // Get single request details
  async getRequest(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user.userId;
      const userRole = req.user.role;
      
      // Find request with all related data
      const request = await prisma.request.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              contactNumber: true,
              address: true,
              avatar: true
            }
          },
          assignedTo: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              contactNumber: true,
              avatar: true
            }
          },
          updates: {
            orderBy: { createdAt: 'desc' },
            include: {
              createdBy: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  avatar: true
                }
              }
            }
          }
        }
      });
      
      if (!request) {
        return res.status(404).json({ 
          success: false, 
          message: 'Request not found' 
        });
      }
      
      // Check permissions
      if (userRole === 'MEMBER' && request.userId !== userId) {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized to view this request' 
        });
      }
      
      logger.info(`Request retrieved: ${id} by user: ${userId}`);
      
      res.json({
        success: true,
        data: request
      });
      
    } catch (error) {
      logger.error('Get request error:', error);
      next(error);
    }
  }
  
  // Update request status
  async updateRequest(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user.userId;
      const userRole = req.user.role;
      const { status, description, files, assignedToId } = req.body;
      
      // Find request
      const request = await prisma.request.findUnique({
        where: { id },
        include: { user: true }
      });
      
      if (!request) {
        return res.status(404).json({ 
          success: false, 
          message: 'Request not found' 
        });
      }
      
      // Check permissions
      if (userRole === 'MEMBER' && request.userId !== userId) {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized to update this request' 
        });
      }
      
      // Prepare update data
      const updateData = {};
      if (status) updateData.status = status;
      if (assignedToId) updateData.assignedToId = assignedToId;
      
      // Update request
      const updatedRequest = await prisma.request.update({
        where: { id },
        data: updateData
      });
      
      // Create update record if description provided
      if (description) {
        // Upload files if provided
        let uploadedFiles = [];
        if (files && files.length > 0) {
          for (const file of files) {
            if (file.base64) {
              const uploadResult = await uploadToCloudinary(file.base64, 'request-updates');
              uploadedFiles.push(uploadResult.secure_url);
            }
          }
        }
        
        await prisma.requestUpdate.create({
          data: {
            requestId: id,
            description,
            status: status || request.status,
            createdById: userId,
            files: uploadedFiles
          }
        });
      }
      
      // Notifications
      if (status && status !== request.status) {
        await sendNotification({
          userId: request.userId,
          type: 'REQUEST_UPDATE',
          title: `Request Status Updated: ${status}`,
          message: `Your request "${request.title}" is now ${status}`,
          link: `/requests/${id}`,
          metadata: {
            requestId: id,
            oldStatus: request.status,
            newStatus: status
          }
        });
      }
      
      // Notify assignee if assigned
      if (assignedToId && assignedToId !== request.assignedToId) {
        await sendNotification({
          userId: assignedToId,
          type: 'VOLUNTEER_ASSIGNMENT',
          title: 'New Assignment',
          message: `You've been assigned to request: ${request.title}`,
          link: `/requests/${id}`,
          metadata: { requestId: id }
        });
      }
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'UPDATE_REQUEST',
          entityType: 'REQUEST',
          entityId: id,
          details: {
            oldStatus: request.status,
            newStatus: status,
            assignedToId
          }
        }
      });
      
      // Emit real-time update via Socket.IO
      if (req.io) {
        req.io.to(`request-${id}`).emit('request-updated', {
          requestId: id,
          status: status || request.status,
          updatedAt: new Date()
        });
      }
      
      logger.info(`Request updated: ${id} by user: ${userId}`);
      
      res.json({
        success: true,
        message: 'Request updated successfully',
        data: updatedRequest
      });
      
    } catch (error) {
      logger.error('Update request error:', error);
      next(error);
    }
  }
  
  // Delete request (soft delete)
  async deleteRequest(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user.userId;
      const userRole = req.user.role;
      
      const request = await prisma.request.findUnique({
        where: { id }
      });
      
      if (!request) {
        return res.status(404).json({ 
          success: false, 
          message: 'Request not found' 
        });
      }
      
      // Check permissions
      if (userRole === 'MEMBER' && request.userId !== userId) {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized to delete this request' 
        });
      }
      
      // Soft delete by updating status
      await prisma.request.update({
        where: { id },
        data: { status: 'CANCELLED' }
      });
      
      // Create update record
      await prisma.requestUpdate.create({
        data: {
          requestId: id,
          description: 'Request cancelled by user',
          status: 'CANCELLED',
          createdById: userId
        }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'DELETE_REQUEST',
          entityType: 'REQUEST',
          entityId: id
        }
      });
      
      logger.info(`Request cancelled: ${id} by user: ${userId}`);
      
      res.json({
        success: true,
        message: 'Request cancelled successfully'
      });
      
    } catch (error) {
      logger.error('Delete request error:', error);
      next(error);
    }
  }
  
  // Get request statistics
  async getRequestStats(req, res, next) {
    try {
      const userId = req.user.userId;
      const userRole = req.user.role;
      
      let where = {};
      
      // Regular users can only see their own stats
      if (userRole === 'MEMBER' || userRole === 'VOLUNTEER') {
        where.userId = userId;
      }
      
      const stats = await prisma.$transaction([
        // Total requests
        prisma.request.count({ where }),
        
        // Requests by status
        prisma.request.groupBy({
          by: ['status'],
          where,
          _count: true
        }),
        
        // Requests by category
        prisma.request.groupBy({
          by: ['category'],
          where,
          _count: true
        }),
        
        // Requests by priority
        prisma.request.groupBy({
          by: ['priority'],
          where,
          _count: true
        }),
        
        // Monthly trend (last 6 months)
        prisma.$queryRaw`
          SELECT 
            DATE_TRUNC('month', "createdAt") as month,
            COUNT(*) as count
          FROM "Request"
          WHERE ${where.userId ? prisma.sql`"userId" = ${userId}` : prisma.sql`1=1`}
            AND "createdAt" >= NOW() - INTERVAL '6 months'
          GROUP BY DATE_TRUNC('month', "createdAt")
          ORDER BY month DESC
        `
      ]);
      
      const [total, byStatus, byCategory, byPriority, monthlyTrend] = stats;
      
      // Calculate average resolution time
      const resolvedRequests = await prisma.request.findMany({
        where: {
          ...where,
          status: 'RESOLVED',
          createdAt: { not: null },
          updatedAt: { not: null }
        },
        select: {
          createdAt: true,
          updatedAt: true
        }
      });
      
      let avgResolutionTime = 0;
      if (resolvedRequests.length > 0) {
        const totalTime = resolvedRequests.reduce((sum, req) => {
          const resolutionTime = new Date(req.updatedAt) - new Date(req.createdAt);
          return sum + resolutionTime;
        }, 0);
        avgResolutionTime = totalTime / resolvedRequests.length;
      }
      
      logger.info(`Request stats retrieved for user: ${userId}`);
      
      res.json({
        success: true,
        data: {
          total,
          byStatus: byStatus.map(s => ({ status: s.status, count: s._count })),
          byCategory: byCategory.map(c => ({ category: c.category, count: c._count })),
          byPriority: byPriority.map(p => ({ priority: p.priority, count: p._count })),
          monthlyTrend,
          avgResolutionTime: this.formatTime(avgResolutionTime)
        }
      });
      
    } catch (error) {
      logger.error('Get request stats error:', error);
      next(error);
    }
  }
  
  // Helper methods
  generateAISuggestions(request) {
    const suggestions = [];
    const now = new Date();
    const requestAge = now - new Date(request.createdAt);
    const hoursOld = requestAge / (1000 * 60 * 60);
    
    // Category-based suggestions
    switch (request.category) {
      case 'MEDICAL':
        suggestions.push(
          'Contact local health center',
          'Check for available medical volunteers',
          'Verify if emergency transport is needed'
        );
        break;
      case 'FOOD':
        suggestions.push(
          'Check community pantry inventory',
          'Coordinate with local suppliers',
          'Schedule delivery if needed'
        );
        break;
      case 'EMERGENCY':
        suggestions.push(
          'Alert emergency response team',
          'Check nearby volunteers',
          'Prepare emergency kit dispatch'
        );
        break;
      case 'INFRASTRUCTURE':
        suggestions.push(
          'Schedule site inspection',
          'Contact barangay engineering team',
          'Check available materials'
        );
        break;
    }
    
    // Priority-based suggestions
    if (request.priority === 'URGENT') {
      suggestions.unshift('Handle immediately - Escalate if needed');
    } else if (request.priority === 'HIGH') {
      suggestions.unshift('Handle within 24 hours');
    }
    
    // Age-based suggestions
    if (hoursOld > 24) {
      suggestions.push('Follow up required - Request pending for over 24 hours');
    }
    if (hoursOld > 72) {
      suggestions.push('Critical - Request pending for over 72 hours');
    }
    
    // Status-based suggestions
    if (request.status === 'IN_PROGRESS') {
      suggestions.push('Check progress with assigned volunteer');
    }
    
    return suggestions.slice(0, 5); // Return top 5 suggestions
  }
  
  calculateAvgResolution(requests) {
    const resolvedRequests = requests.filter(r => 
      r.status === 'RESOLVED' && r.createdAt && r.updatedAt
    );
    
    if (resolvedRequests.length === 0) return null;
    
    const totalTime = resolvedRequests.reduce((sum, req) => {
      const resolutionTime = new Date(req.updatedAt) - new Date(req.createdAt);
      return sum + resolutionTime;
    }, 0);
    
    return totalTime / resolvedRequests.length;
  }
  
  formatTime(milliseconds) {
    if (!milliseconds) return 'N/A';
    
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

module.exports = new RequestController();
