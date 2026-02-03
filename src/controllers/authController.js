const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { prisma } = require('../app');
const { sendEmail } = require('../utils/emailService');
const { generateOTP, validatePassword } = require('../utils/helpers');
const logger = require('../utils/logger');

class AuthController {
  // Register new user
  async register(req, res, next) {
    try {
      const { email, password, firstName, lastName, contactNumber, role, address } = req.body;
      
      // Validate input
      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({ 
          success: false, 
          message: 'Missing required fields' 
        });
      }
      
      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          message: passwordValidation.message
        });
      }
      
      // Check if user exists
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(400).json({ 
          success: false, 
          message: 'Email already registered' 
        });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 12);
      
      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      // Create user
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName,
          lastName,
          contactNumber,
          address,
          role: role || 'MEMBER',
          verificationToken,
          isVerified: false
        }
      });
      
      // Create verification record
      await prisma.verificationToken.create({
        data: {
          token: verificationToken,
          userId: user.id,
          expires: verificationExpires
        }
      });
      
      // Send verification email
      await sendEmail({
        to: email,
        subject: 'Verify Your BarangayLink Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Welcome to BarangayLink, ${firstName}!</h2>
            <p>Thank you for registering. Please verify your email by clicking the button below:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}" 
                 style="background-color: #3b82f6; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 5px; font-weight: bold;">
                Verify Email Address
              </a>
            </div>
            <p>Or copy and paste this link in your browser:</p>
            <p style="word-break: break-all; color: #666;">
              ${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}
            </p>
            <p>This link will expire in 24 hours.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">
              If you didn't create this account, you can safely ignore this email.
            </p>
          </div>
        `
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'REGISTER',
          entityType: 'USER',
          entityId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          details: { email, role: user.role }
        }
      });
      
      // Generate JWT token for immediate login
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          role: user.role 
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      // Remove sensitive data from response
      const userResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        contactNumber: user.contactNumber,
        address: user.address,
        isVerified: user.isVerified,
        avatar: user.avatar,
        createdAt: user.createdAt
      };
      
      logger.info(`User registered: ${user.email}`);
      
      res.status(201).json({
        success: true,
        message: 'Registration successful. Please verify your email.',
        token,
        user: userResponse
      });
      
    } catch (error) {
      logger.error('Registration error:', error);
      next(error);
    }
  }
  
  // Login user
  async login(req, res, next) {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ 
          success: false, 
          message: 'Email and password are required' 
        });
      }
      
      // Find user with profile
      const user = await prisma.user.findUnique({ 
        where: { email },
        include: {
          volunteer: true
        }
      });
      
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid credentials' 
        });
      }
      
      // Check password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid credentials' 
        });
      }
      
      // Check if verified
      if (!user.isVerified) {
        return res.status(403).json({ 
          success: false, 
          message: 'Please verify your email first' 
        });
      }
      
      // Check if account is locked (optional - add locked field to User model)
      
      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          role: user.role 
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { updatedAt: new Date() }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'LOGIN',
          entityType: 'USER',
          entityId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']
        }
      });
      
      // Remove sensitive data from response
      const userResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        contactNumber: user.contactNumber,
        address: user.address,
        isVerified: user.isVerified,
        avatar: user.avatar,
        volunteer: user.volunteer,
        createdAt: user.createdAt
      };
      
      logger.info(`User logged in: ${user.email}`);
      
      res.json({
        success: true,
        token,
        user: userResponse
      });
      
    } catch (error) {
      logger.error('Login error:', error);
      next(error);
    }
  }
  
  // Verify email
  async verifyEmail(req, res, next) {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({ 
          success: false, 
          message: 'Verification token is required' 
        });
      }
      
      // Find verification token
      const verification = await prisma.verificationToken.findFirst({
        where: { 
          token,
          expires: { gt: new Date() }
        },
        include: { user: true }
      });
      
      if (!verification) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid or expired verification token' 
        });
      }
      
      // Update user verification status
      await prisma.user.update({
        where: { id: verification.userId },
        data: { 
          isVerified: true,
          verificationToken: null 
        }
      });
      
      // Delete verification token
      await prisma.verificationToken.delete({
        where: { id: verification.id }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: verification.userId,
          action: 'EMAIL_VERIFIED',
          entityType: 'USER',
          entityId: verification.userId
        }
      });
      
      logger.info(`Email verified for user: ${verification.user.email}`);
      
      res.json({
        success: true,
        message: 'Email verified successfully'
      });
      
    } catch (error) {
      logger.error('Email verification error:', error);
      next(error);
    }
  }
  
  // Request OTP for verification
  async requestOTP(req, res, next) {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ 
          success: false, 
          message: 'Email is required' 
        });
      }
      
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Don't reveal that user doesn't exist (security)
        return res.json({ 
          success: true, 
          message: 'If email exists, OTP will be sent' 
        });
      }
      
      const otp = generateOTP(6);
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      
      // Store OTP (create OTP model if needed)
      await prisma.otpToken.create({
        data: {
          token: otp,
          userId: user.id,
          expires: otpExpiry,
          type: 'VERIFICATION'
        }
      });
      
      // Send OTP email
      await sendEmail({
        to: email,
        subject: 'Your BarangayLink OTP Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Your OTP Code</h2>
            <p>Use the following OTP code to verify your account:</p>
            <div style="background-color: #f3f4f6; padding: 20px; text-align: center; 
                        margin: 30px 0; border-radius: 10px;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; 
                          color: #3b82f6;">
                ${otp}
              </span>
            </div>
            <p>This OTP will expire in 10 minutes.</p>
            <p style="color: #666; font-size: 12px;">
              If you didn't request this OTP, please ignore this email.
            </p>
          </div>
        `
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'OTP_REQUESTED',
          entityType: 'USER',
          entityId: user.id
        }
      });
      
      logger.info(`OTP sent to: ${email}`);
      
      res.json({ 
        success: true, 
        message: 'OTP sent successfully' 
      });
      
    } catch (error) {
      logger.error('OTP request error:', error);
      next(error);
    }
  }
  
  // Forgot password
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ 
          success: false, 
          message: 'Email is required' 
        });
      }
      
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Don't reveal that user doesn't exist
        return res.json({ 
          success: true, 
          message: 'If email exists, reset instructions will be sent' 
        });
      }
      
      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour
      
      // Update user with reset token
      await prisma.user.update({
        where: { id: user.id },
        data: { 
          resetToken, 
          resetExpires 
        }
      });
      
      // Send reset email
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
      
      await sendEmail({
        to: email,
        subject: 'Reset Your BarangayLink Password',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Password Reset Request</h2>
            <p>We received a request to reset your password. Click the button below to proceed:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="background-color: #3b82f6; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 5px; font-weight: bold;">
                Reset Password
              </a>
            </div>
            <p>Or copy and paste this link in your browser:</p>
            <p style="word-break: break-all; color: #666;">
              ${resetUrl}
            </p>
            <p>This link will expire in 1 hour.</p>
            <p style="color: #666; font-size: 12px;">
              If you didn't request a password reset, please ignore this email.
            </p>
          </div>
        `
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'USER',
          entityId: user.id,
          ipAddress: req.ip
        }
      });
      
      logger.info(`Password reset requested for: ${email}`);
      
      res.json({ 
        success: true, 
        message: 'Password reset instructions sent' 
      });
      
    } catch (error) {
      logger.error('Forgot password error:', error);
      next(error);
    }
  }
  
  // Reset password
  async resetPassword(req, res, next) {
    try {
      const { token, password } = req.body;
      
      if (!token || !password) {
        return res.status(400).json({ 
          success: false, 
          message: 'Token and password are required' 
        });
      }
      
      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          message: passwordValidation.message
        });
      }
      
      const user = await prisma.user.findFirst({
        where: {
          resetToken: token,
          resetExpires: { gt: new Date() }
        }
      });
      
      if (!user) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid or expired token' 
        });
      }
      
      // Hash new password
      const hashedPassword = await bcrypt.hash(password, 12);
      
      // Update user
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetExpires: null
        }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_RESET',
          entityType: 'USER',
          entityId: user.id,
          ipAddress: req.ip
        }
      });
      
      logger.info(`Password reset for user: ${user.email}`);
      
      res.json({ 
        success: true, 
        message: 'Password reset successful' 
      });
      
    } catch (error) {
      logger.error('Reset password error:', error);
      next(error);
    }
  }
  
  // Get current user profile
  async getProfile(req, res, next) {
    try {
      const userId = req.user.userId;
      
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          volunteer: true,
          _count: {
            select: {
              requests: true,
              donations: true,
              events: true
            }
          }
        }
      });
      
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          message: 'User not found' 
        });
      }
      
      // Remove sensitive data
      const userResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        contactNumber: user.contactNumber,
        address: user.address,
        birthDate: user.birthDate,
        avatar: user.avatar,
        isVerified: user.isVerified,
        volunteer: user.volunteer,
        counts: user._count,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };
      
      res.json({
        success: true,
        user: userResponse
      });
      
    } catch (error) {
      logger.error('Get profile error:', error);
      next(error);
    }
  }
  
  // Update user profile
  async updateProfile(req, res, next) {
    try {
      const userId = req.user.userId;
      const updates = req.body;
      
      // Remove fields that shouldn't be updated
      delete updates.email;
      delete updates.password;
      delete updates.role;
      delete updates.isVerified;
      
      // Update user
      const user = await prisma.user.update({
        where: { id: userId },
        data: updates,
        include: { volunteer: true }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'PROFILE_UPDATED',
          entityType: 'USER',
          entityId: userId,
          details: { updates }
        }
      });
      
      // Remove sensitive data from response
      const userResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        contactNumber: user.contactNumber,
        address: user.address,
        birthDate: user.birthDate,
        avatar: user.avatar,
        isVerified: user.isVerified,
        volunteer: user.volunteer,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };
      
      logger.info(`Profile updated for user: ${user.email}`);
      
      res.json({
        success: true,
        message: 'Profile updated successfully',
        user: userResponse
      });
      
    } catch (error) {
      logger.error('Update profile error:', error);
      next(error);
    }
  }
  
  // Change password
  async changePassword(req, res, next) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ 
          success: false, 
          message: 'Current and new password are required' 
        });
      }
      
      // Get user with password
      const user = await prisma.user.findUnique({ 
        where: { id: userId } 
      });
      
      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ 
          success: false, 
          message: 'Current password is incorrect' 
        });
      }
      
      // Validate new password strength
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          message: passwordValidation.message
        });
      }
      
      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      
      // Update password
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword }
      });
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'PASSWORD_CHANGED',
          entityType: 'USER',
          entityId: userId
        }
      });
      
      logger.info(`Password changed for user: ${user.email}`);
      
      res.json({ 
        success: true, 
        message: 'Password changed successfully' 
      });
      
    } catch (error) {
      logger.error('Change password error:', error);
      next(error);
    }
  }
  
  // Logout (client-side token destruction)
  async logout(req, res, next) {
    try {
      const userId = req.user.userId;
      
      // Create activity log
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'LOGOUT',
          entityType: 'USER',
          entityId: userId,
          ipAddress: req.ip
        }
      });
      
      logger.info(`User logged out: ${req.user.email}`);
      
      res.json({ 
        success: true, 
        message: 'Logged out successfully' 
      });
      
    } catch (error) {
      logger.error('Logout error:', error);
      next(error);
    }
  }
}

module.exports = new AuthController();
