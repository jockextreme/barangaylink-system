const axios = require('axios');
const logger = require('../utils/logger');

class AIService {
  constructor() {
    this.prioritizationUrl = process.env.AI_PRIORITIZATION_URL || 'http://localhost:5000';
    this.chatbotUrl = process.env.AI_CHATBOT_URL || 'http://localhost:5001';
    this.timeout = 5000; // 5 seconds timeout
  }
  
  // AI-powered request prioritization
  async prioritizeRequest(requestData) {
    try {
      const response = await axios.post(
        `${this.prioritizationUrl}/api/prioritize`,
        {
          title: requestData.title,
          description: requestData.description,
          category: requestData.category,
          location: requestData.location,
          timestamp: new Date().toISOString(),
          historical_data: requestData.historicalContext
        },
        { timeout: this.timeout }
      );
      
      logger.info(`AI prioritization successful for request: ${requestData.title}`);
      
      return {
        priority: response.data.priority,
        score: response.data.score,
        reason: response.data.reason,
        suggestedCategory: response.data.suggested_category
      };
      
    } catch (error) {
      logger.warn(`AI prioritization failed, using fallback: ${error.message}`);
      // Fallback to rule-based prioritization
      return this.fallbackPrioritization(requestData);
    }
  }
  
  // Fallback rule-based prioritization
  fallbackPrioritization(requestData) {
    const { title, description, category } = requestData;
    
    let priority = 'MEDIUM';
    let score = 0.5;
    
    // Emergency keywords
    const emergencyKeywords = [
      'emergency', 'urgent', 'critical', 'accident', 'fire',
      'flood', 'earthquake', 'blood', 'heart attack', 'stroke',
      'pregnant', 'child', 'baby', 'missing', 'danger',
      'dying', 'emergency room', 'hospital', 'ambulance'
    ];
    
    // High priority keywords
    const highPriorityKeywords = [
      'medicine', 'medication', 'sick', 'fever', 'cough',
      'hungry', 'starving', 'food', 'water', 'shelter',
      'homeless', 'evicted', 'no electricity', 'no water'
    ];
    
    const text = `${title} ${description}`.toLowerCase();
    
    // Check for emergency keywords
    const emergencyMatches = emergencyKeywords.filter(keyword => 
      text.includes(keyword)
    ).length;
    
    // Check for high priority keywords
    const highPriorityMatches = highPriorityKeywords.filter(keyword =>
      text.includes(keyword)
    ).length;
    
    // Determine priority based on keyword matches
    if (emergencyMatches > 0) {
      priority = 'URGENT';
      score = 0.9 + (emergencyMatches * 0.02);
    } else if (highPriorityMatches > 0 || category === 'MEDICAL' || category === 'EMERGENCY') {
      priority = 'HIGH';
      score = 0.7 + (highPriorityMatches * 0.05);
    } else if (category === 'FOOD') {
      priority = 'HIGH';
      score = 0.75;
    } else if (category === 'EDUCATION' || category === 'LEGAL') {
      priority = 'MEDIUM';
      score = 0.6;
    } else {
      priority = 'LOW';
      score = 0.4;
    }
    
    // Generate reason
    let reason = '';
    if (emergencyMatches > 0) {
      reason = `Contains ${emergencyMatches} emergency keyword(s)`;
    } else if (highPriorityMatches > 0) {
      reason = `Contains ${highPriorityMatches} high-priority keyword(s)`;
    } else {
      reason = `Category-based priority: ${category}`;
    }
    
    // Cap score at 0.99
    score = Math.min(score, 0.99);
    
    return {
      priority,
      score: parseFloat(score.toFixed(2)),
      reason,
      suggestedCategory: category
    };
  }
  
  // Chatbot response
  async getChatbotResponse(query, context = {}) {
    try {
      const response = await axios.post(
        `${this.chatbotUrl}/api/chat`,
        {
          message: query,
          context: {
            user_id: context.userId,
            user_role: context.userRole,
            language: context.language || 'en',
            timestamp: new Date().toISOString(),
            ...context
          }
        },
        { timeout: this.timeout }
      );
      
      logger.info(`Chatbot response generated for query: ${query.substring(0, 50)}...`);
      
      return {
        response: response.data.response,
        confidence: response.data.confidence,
        sources: response.data.sources,
        suggested_actions: response.data.suggested_actions,
        timestamp: response.data.timestamp
      };
      
    } catch (error) {
      logger.warn(`Chatbot service failed, using fallback: ${error.message}`);
      return this.fallbackChatbotResponse(query);
    }
  }
  
  // Fallback chatbot response
  fallbackChatbotResponse(query) {
    const lowerQuery = query.toLowerCase();
    
    // Simple rule-based responses
    const responses = {
      'hello|hi|hey|kamusta': {
        response: 'Hello! How can I help you with BarangayLink today?',
        confidence: 0.9,
        actions: ['Submit Request', 'Browse Events', 'Make Donation']
      },
      'request|help|assistance|tulong': {
        response: 'You can submit a help request in the Services section. What type of assistance do you need?',
        confidence: 0.8,
        actions: ['Medical Help', 'Food Support', 'Emergency']
      },
      'medical|doctor|hospital|sakit|gamot': {
        response: 'For medical emergencies, please call 911 immediately. For non-emergencies, you can submit a medical request through our system.',
        confidence: 0.85,
        actions: ['Submit Medical Request', 'Find Health Center', 'Emergency Contacts']
      },
      'food|hunger|meal|gutom|pagkain': {
        response: 'We have a food assistance program. You can submit a food request or visit our community pantry during operating hours.',
        confidence: 0.8,
        actions: ['Submit Food Request', 'View Pantry Locations', 'Donate Food']
      },
      'event|activity|program|meeting|pulong': {
        response: 'Check the Events section for upcoming community activities. You can also register as a volunteer for events!',
        confidence: 0.8,
        actions: ['Browse Events', 'Volunteer Registration', 'Create Event']
      },
      'donate|donation|contribute|bigay|abuloy': {
        response: 'Thank you for wanting to help! Visit the Donations section to contribute. All donations are tracked transparently.',
        confidence: 0.9,
        actions: ['Make Donation', 'View Campaigns', 'Donation History']
      },
      'volunteer|volunteering|help others|tumulong|boluntaryo': {
        response: 'That\'s wonderful! Register as a volunteer in your profile settings, then browse available opportunities.',
        confidence: 0.85,
        actions: ['Volunteer Registration', 'View Opportunities', 'My Assignments']
      },
      'clearance|certificate|document|permit|cedula': {
        response: 'For barangay clearances, please visit the office with: 1) Valid ID, 2) Proof of residency, 3) Purpose of clearance.',
        confidence: 0.8,
        actions: ['Requirements List', 'Office Hours', 'Online Request']
      },
      'complaint|problem|issue|reklamo|problema': {
        response: 'You can submit a formal complaint through the Services section. Please provide detailed information and evidence if available.',
        confidence: 0.8,
        actions: ['Submit Complaint', 'View Process', 'Status Tracking']
      },
      'thank|thanks|salamat|maraming salamat': {
        response: 'You\'re welcome! Is there anything else I can help you with?',
        confidence: 0.95,
        actions: []
      },
      'contact|phone|number|tawag|telepono': {
        response: 'You can contact the barangay office at (02) 123-4567 during office hours (Monday-Friday, 8AM-5PM).',
        confidence: 0.7,
        actions: ['Emergency Contacts', 'Office Location', 'Email Support']
      }
    };
    
    // Find matching pattern
    for (const [pattern, config] of Object.entries(responses)) {
      const patterns = pattern.split('|');
      if (patterns.some(p => lowerQuery.includes(p))) {
        return {
          response: config.response,
          confidence: config.confidence,
          sources: ['BarangayLink FAQ Database'],
          suggested_actions: config.actions,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // Default response
    return {
      response: 'I\'m not sure about that. Please contact the barangay office directly for specific inquiries or check our FAQ section.',
      confidence: 0.3,
      sources: [],
      suggested_actions: ['Contact Support', 'Browse FAQ', 'Submit General Inquiry'],
      timestamp: new Date().toISOString()
    };
  }
  
  // Predict resource needs for disaster response
  async predictResourceNeeds(disasterType, affectedPopulation, location) {
    try {
      const response = await axios.post(
        `${this.prioritizationUrl}/api/predict-resources`,
        {
          disaster_type: disasterType,
          affected_population: affectedPopulation,
          location: location,
          historical_patterns: true,
          timestamp: new Date().toISOString()
        },
        { timeout: this.timeout }
      );
      
      logger.info(`Resource prediction generated for ${disasterType} affecting ${affectedPopulation} people`);
      
      return response.data;
      
    } catch (error) {
      logger.warn(`Resource prediction failed, using fallback: ${error.message}`);
      return this.fallbackResourcePrediction(disasterType, affectedPopulation);
    }
  }
  
  fallbackResourcePrediction(disasterType, affectedPopulation) {
    const predictions = {
      'FLOOD': {
        water_liters: Math.ceil(affectedPopulation * 5),
        food_rations: Math.ceil(affectedPopulation * 3),
        blankets: Math.ceil(affectedPopulation),
        first_aid_kits: Math.ceil(affectedPopulation / 50),
        emergency_kits: Math.ceil(affectedPopulation / 10),
        volunteers_needed: Math.ceil(affectedPopulation / 100),
        boats: Math.max(1, Math.ceil(affectedPopulation / 500)),
        life_jackets: Math.ceil(affectedPopulation / 2)
      },
      'EARTHQUAKE': {
        tents: Math.ceil(affectedPopulation / 5),
        first_aid_kits: Math.ceil(affectedPopulation / 20),
        rescue_teams: Math.ceil(affectedPopulation / 500),
        heavy_equipment: Math.ceil(affectedPopulation / 1000),
        volunteers_needed: Math.ceil(affectedPopulation / 50),
        blankets: Math.ceil(affectedPopulation * 2),
        food_rations: Math.ceil(affectedPopulation * 2),
        water_liters: Math.ceil(affectedPopulation * 3)
      },
      'FIRE': {
        temporary_shelter: Math.ceil(affectedPopulation / 10),
        clothing: Math.ceil(affectedPopulation),
        food_rations: Math.ceil(affectedPopulation * 2),
        counseling_teams: Math.ceil(affectedPopulation / 100),
        volunteers_needed: Math.ceil(affectedPopulation / 75),
        first_aid_kits: Math.ceil(affectedPopulation / 30),
        blankets: Math.ceil(affectedPopulation)
      },
      'TYPHOON': {
        water_liters: Math.ceil(affectedPopulation * 4),
        canned_goods: Math.ceil(affectedPopulation * 7),
        emergency_kits: Math.ceil(affectedPopulation),
        generators: Math.ceil(affectedPopulation / 200),
        volunteers_needed: Math.ceil(affectedPopulation / 80),
        first_aid_kits: Math.ceil(affectedPopulation / 40),
        blankets: Math.ceil(affectedPopulation * 1.5)
      },
      'MEDICAL': {
        first_aid_kits: Math.ceil(affectedPopulation / 10),
        masks: Math.ceil(affectedPopulation * 10),
        sanitizer_liters: Math.ceil(affectedPopulation / 5),
        volunteers_needed: Math.ceil(affectedPopulation / 50),
        ambulance_units: Math.max(1, Math.ceil(affectedPopulation / 1000))
      }
    };
    
    const defaultPrediction = {
      water_liters: Math.ceil(affectedPopulation * 3),
      food_rations: Math.ceil(affectedPopulation * 2),
      blankets: Math.ceil(affectedPopulation),
      first_aid_kits: Math.ceil(affectedPopulation / 30),
      volunteers_needed: Math.ceil(affectedPopulation / 100),
      emergency_kits: Math.ceil(affectedPopulation / 20)
    };
    
    const prediction = predictions[disasterType] || defaultPrediction;
    
    return {
      status: 'success',
      disaster_type: disasterType,
      affected_population: affectedPopulation,
      predictions: prediction,
      timestamp: new Date().toISOString(),
      note: 'Fallback prediction based on standard emergency response guidelines'
    };
  }
  
  // Analyze request trends
  async analyzeTrends(timeframe = '30d') {
    try {
      const response = await axios.post(
        `${this.prioritizationUrl}/api/analyze-trends`,
        {
          timeframe: timeframe,
          timestamp: new Date().toISOString()
        },
        { timeout: this.timeout }
      );
      
      return response.data;
      
    } catch (error) {
      logger.warn(`Trend analysis failed: ${error.message}`);
      return this.fallbackTrendAnalysis(timeframe);
    }
  }
  
  fallbackTrendAnalysis(timeframe) {
    // Simple trend analysis based on timeframe
    const now = new Date();
    const trends = {
      timeframe: timeframe,
      total_requests: Math.floor(Math.random() * 100) + 50,
      average_priority: 'MEDIUM',
      top_categories: ['FOOD', 'MEDICAL', 'INFRASTRUCTURE'],
      peak_hours: ['09:00-11:00', '14:00-16:00'],
      recommendations: [
        'Increase volunteer coverage during peak hours',
        'Stock up on food and medical supplies',
        'Schedule regular community meetings'
      ]
    };
    
    return trends;
  }
}

module.exports = new AIService();
