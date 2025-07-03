const express = require('express');
const cors = require('cors');
const { Client } = require('pg');

// Set timezone to UTC+7 (Asia/Jakarta)
process.env.TZ = 'Asia/Jakarta';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Database connection
function createDBConnection() {
  return new Client({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
}



// Error handler
const handleError = (res, error, context) => {
  console.error(`[${context}] ${error.message}`);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: error.message,
    context 
  });
};

// Dashboard stats
app.get('/api/dashboard/stats', async (_, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    // Get basic stats
    const userCountQuery = 'SELECT COUNT(*) as total_users FROM usernames';
    
    // Use conversation_stats table if available, otherwise calculate
    const conversationStatsQuery = `
      SELECT 
        total_conversations,
        active_conversations,
        ended_conversations,
        avg_messages_per_conversation,
        conversations_today
      FROM conversation_stats
      LIMIT 1
    `;
    
    // If conversation_stats doesn't have data, fallback to manual calculation
    const conversationStatsFallbackQuery = `
      SELECT 
        COUNT(*) as total_conversations,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_conversations,
        COUNT(CASE WHEN status = 'ended' THEN 1 END) as ended_conversations,
        AVG(message_count) as avg_messages_per_conversation,
        COUNT(CASE WHEN DATE(started_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE THEN 1 END) as conversations_today
      FROM conversations
    `;
    
    const messageStatsQuery = `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(DISTINCT sender_user_id) as unique_senders
      FROM chat_logs 
    `;
    
    const genderStatsQuery = `
      SELECT 
        gender, 
        COUNT(*) as count 
      FROM usernames 
      GROUP BY gender
    `;

    const dailyMessagesQuery = `
      SELECT 
        DATE(timestamp AT TIME ZONE 'Asia/Jakarta') as message_date,
        COUNT(*) as daily_messages
      FROM chat_logs 
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(timestamp AT TIME ZONE 'Asia/Jakarta')
      ORDER BY message_date DESC
      LIMIT 7
    `;

    const [userCount, genderStats, messageStats, dailyMessages] = await Promise.all([
      client.query(userCountQuery),
      client.query(genderStatsQuery),
      client.query(messageStatsQuery),
      client.query(dailyMessagesQuery)
    ]);

    // Try to get conversation stats from conversation_stats table first
    let conversationStats;
    try {
      const statsResult = await client.query(conversationStatsQuery);
      if (statsResult.rows.length > 0) {
        conversationStats = statsResult.rows[0];
      } else {
        const fallbackResult = await client.query(conversationStatsFallbackQuery);
        conversationStats = fallbackResult.rows[0];
      }
    } catch (error) {
      // If conversation_stats table doesn't exist, use fallback
      const fallbackResult = await client.query(conversationStatsFallbackQuery);
      conversationStats = fallbackResult.rows[0];
    }

    res.json({
      users: {
        total: parseInt(userCount.rows[0].total_users),
        byGender: genderStats.rows
      },
      conversations: {
        total: parseInt(conversationStats.total_conversations || 0),
        active: parseInt(conversationStats.active_conversations || 0),
        ended: parseInt(conversationStats.ended_conversations || 0),
        avgMessages: Math.round(conversationStats.avg_messages_per_conversation || 0),
        today: parseInt(conversationStats.conversations_today || 0)
      },
      messages: {
        total: parseInt(messageStats.rows[0]?.total_messages || 0),
        uniqueSenders: parseInt(messageStats.rows[0]?.unique_senders || 0),
        dailyStats: dailyMessages.rows
      }
    });
    
  } catch (error) {
    handleError(res, error, 'dashboard stats');
  } finally {
    await client.end();
  }
});

// Get all users with pagination
app.get('/api/users', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const gender = req.query.gender || '';
    
    let whereClause = '';
    let queryParams = [];
    let paramIndex = 1;
    
    if (search) {
      whereClause += ` WHERE username ILIKE $${paramIndex}`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    if (gender) {
      whereClause += search ? ` AND gender = $${paramIndex}` : ` WHERE gender = $${paramIndex}`;
      queryParams.push(gender);
      paramIndex++;
    }
    
    const countQuery = `SELECT COUNT(*) as total FROM usernames${whereClause}`;
    const usersQuery = `
      SELECT 
        user_id,
        username,
        gender
      FROM usernames
      ${whereClause}
      ORDER BY user_id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    queryParams.push(limit, offset);
    
    const [countResult, usersResult] = await Promise.all([
      client.query(countQuery, queryParams.slice(0, -2)),
      client.query(usersQuery, queryParams)
    ]);
    
    const totalUsers = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalUsers / limit);
    
    res.json({
      users: usersResult.rows,
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    handleError(res, error, 'get users');
  } finally {
    await client.end();
  }
});

// Get user details by ID or username
app.get('/api/users/:identifier', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const { identifier } = req.params;
    const isUserId = !isNaN(identifier);
    
    let userQuery, queryParam;
    if (isUserId) {
      userQuery = 'SELECT * FROM usernames WHERE user_id = $1';
      queryParam = parseInt(identifier);
    } else {
      userQuery = 'SELECT * FROM usernames WHERE username = $1';
      queryParam = identifier.startsWith('@') ? identifier : `@${identifier}`;
    }
    
    const userResult = await client.query(userQuery, [queryParam]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Get user conversation count
    const conversationCountQuery = `
      SELECT COUNT(*) as conversation_count 
      FROM conversations 
      WHERE user1_id = $1 OR user2_id = $1
    `;
    
    // Get user message count
    const messageCountQuery = `
      SELECT COUNT(*) as message_count 
      FROM chat_logs 
      WHERE sender_user_id = $1
    `;
    
    // Get recent conversations
    const recentConversationsQuery = `
      SELECT 
        id,
        CASE 
          WHEN user1_id = $1 THEN user2_username
          ELSE user1_username
        END as partner_username,
        started_at,
        ended_at,
        status,
        (SELECT COUNT(*) FROM chat_logs WHERE conversation_id = conversations.id) as message_count
      FROM conversations 
      WHERE user1_id = $1 OR user2_id = $1
      ORDER BY started_at DESC
      LIMIT 10
    `;
    
    const [conversationCount, messageCount, recentConversations] = await Promise.all([
      client.query(conversationCountQuery, [user.user_id]),
      client.query(messageCountQuery, [user.user_id]),
      client.query(recentConversationsQuery, [user.user_id])
    ]);
    
    res.json({
      user,
      stats: {
        conversationCount: parseInt(conversationCount.rows[0].conversation_count),
        messageCount: parseInt(messageCount.rows[0].message_count)
      },
      recentConversations: recentConversations.rows
    });
    
  } catch (error) {
    handleError(res, error, 'get user details');
  } finally {
    await client.end();
  }
});

// Get all conversations with pagination
app.get('/api/conversations', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status || '';
    const search = req.query.search || '';
    
    let whereClause = '';
    let queryParams = [];
    let paramIndex = 1;
    
    if (status) {
      whereClause += ` WHERE status = $${paramIndex}`;
      queryParams.push(status);
      paramIndex++;
    }
    
    if (search) {
      const searchCondition = ` (user1_username ILIKE $${paramIndex} OR user2_username ILIKE $${paramIndex})`;
      whereClause += status ? ` AND ${searchCondition}` : ` WHERE ${searchCondition}`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    const countQuery = `SELECT COUNT(*) as total FROM conversations${whereClause}`;
    const conversationsQuery = `
      SELECT 
        id,
        user1_id,
        user1_username,
        user2_id,
        user2_username,
        started_at,
        ended_at,
        status,
        (SELECT COUNT(*) FROM chat_logs WHERE conversation_id = conversations.id) as message_count
      FROM conversations
      ${whereClause}
      ORDER BY started_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    queryParams.push(limit, offset);
    
    const [countResult, conversationsResult] = await Promise.all([
      client.query(countQuery, queryParams.slice(0, -2)),
      client.query(conversationsQuery, queryParams)
    ]);
    
    const totalConversations = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalConversations / limit);
    
    res.json({
      conversations: conversationsResult.rows,
      pagination: {
        currentPage: page,
        totalPages,
        totalConversations,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    handleError(res, error, 'get conversations');
  } finally {
    await client.end();
  }
});

// Get conversation details
app.get('/api/conversations/:conversationId', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const { conversationId } = req.params;
    
    // Get conversation details
    const conversationQuery = `
      SELECT *, 
        (SELECT COUNT(*) FROM chat_logs WHERE conversation_id = conversations.id) as actual_message_count
      FROM conversations WHERE id = $1
    `;
    
    // Get messages for this conversation
    const messagesQuery = `
      SELECT 
        sender_user_id,
        sender_username,
        receiver_user_id,
        receiver_username,
        message,
        timestamp
      FROM chat_logs 
      WHERE conversation_id = $1
      ORDER BY timestamp ASC
    `;
    
    const [conversationResult, messagesResult] = await Promise.all([
      client.query(conversationQuery, [conversationId]),
      client.query(messagesQuery, [conversationId])
    ]);
    
    if (conversationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    res.json({
      conversation: conversationResult.rows[0],
      messages: messagesResult.rows
    });
    
  } catch (error) {
    handleError(res, error, 'get conversation details');
  } finally {
    await client.end();
  }
});

// Get all messages with pagination and filters
app.get('/api/messages', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const conversationId = req.query.conversation_id || '';
    const userId = req.query.user_id || '';
    const search = req.query.search || '';
    const dateFrom = req.query.date_from || '';
    const dateTo = req.query.date_to || '';
    
    let whereClause = '';
    let queryParams = [];
    let paramIndex = 1;
    
    if (conversationId) {
      whereClause += ` WHERE conversation_id = $${paramIndex}`;
      queryParams.push(conversationId);
      paramIndex++;
    }
    
    if (userId) {
      const userCondition = ` (sender_user_id = $${paramIndex} OR receiver_user_id = $${paramIndex})`;
      whereClause += conversationId ? ` AND ${userCondition}` : ` WHERE ${userCondition}`;
      queryParams.push(parseInt(userId));
      paramIndex++;
    }
    
    if (search) {
      const searchCondition = ` message ILIKE $${paramIndex}`;
      whereClause += (conversationId || userId) ? ` AND ${searchCondition}` : ` WHERE ${searchCondition}`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    if (dateFrom) {
      const dateCondition = ` timestamp >= $${paramIndex}`;
      whereClause += (conversationId || userId || search) ? ` AND ${dateCondition}` : ` WHERE ${dateCondition}`;
      queryParams.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      const dateCondition = ` timestamp <= $${paramIndex}`;
      whereClause += (conversationId || userId || search || dateFrom) ? ` AND ${dateCondition}` : ` WHERE ${dateCondition}`;
      queryParams.push(dateTo);
      paramIndex++;
    }
    
    const countQuery = `SELECT COUNT(*) as total FROM chat_logs${whereClause}`;
    const messagesQuery = `
      SELECT 
        conversation_id,
        sender_user_id,
        sender_username,
        receiver_user_id,
        receiver_username,
        message,
        timestamp
      FROM chat_logs
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    queryParams.push(limit, offset);
    
    const [countResult, messagesResult] = await Promise.all([
      client.query(countQuery, queryParams.slice(0, -2)),
      client.query(messagesQuery, queryParams)
    ]);
    
    const totalMessages = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalMessages / limit);
    
    res.json({
      messages: messagesResult.rows,
      pagination: {
        currentPage: page,
        totalPages,
        totalMessages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    handleError(res, error, 'get messages');
  } finally {
    await client.end();
  }
});

// Get user's conversation list
app.get('/api/users/:userId/conversations', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const conversationsQuery = `
      SELECT 
        id,
        CASE 
          WHEN user1_id = $1 THEN user2_id
          ELSE user1_id
        END as partner_id,
        CASE 
          WHEN user1_id = $1 THEN user2_username
          ELSE user1_username
        END as partner_username,
        started_at,
        ended_at,
        status,
        (SELECT COUNT(*) FROM chat_logs WHERE conversation_id = conversations.id) as message_count
      FROM conversations 
      WHERE user1_id = $1 OR user2_id = $1
      ORDER BY started_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM conversations 
      WHERE user1_id = $1 OR user2_id = $1
    `;
    
    const [conversationsResult, countResult] = await Promise.all([
      client.query(conversationsQuery, [parseInt(userId), limit, offset]),
      client.query(countQuery, [parseInt(userId)])
    ]);
    
    const totalConversations = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalConversations / limit);
    
    res.json({
      conversations: conversationsResult.rows,
      pagination: {
        currentPage: page,
        totalPages,
        totalConversations,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    handleError(res, error, 'get user conversations');
  } finally {
    await client.end();
  }
});

// Search users
app.get('/api/users/search/:query', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const { query } = req.params;
    const limit = parseInt(req.query.limit) || 10;
    
    const searchQuery = `
      SELECT 
        user_id,
        username,
        gender
      FROM usernames 
      WHERE username ILIKE $1 OR user_id::text = $2
      ORDER BY username
      LIMIT $3
    `;
    
    const result = await client.query(searchQuery, [`%${query}%`, query, limit]);
    
    res.json({
      users: result.rows
    });
    
  } catch (error) {
    handleError(res, error, 'search users');
  } finally {
    await client.end();
  }
});

// Get recent activity
app.get('/api/activity/recent', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const limit = parseInt(req.query.limit) || 20;
    
    // Get recent conversations
    const recentConversationsQuery = `
      SELECT 
        'conversation' as type,
        id as reference_id,
        user1_username,
        user2_username,
        started_at as timestamp,
        status
      FROM conversations 
      ORDER BY started_at DESC
      LIMIT $1
    `;
    
    // Get recent messages
    const recentMessagesQuery = `
      SELECT 
        'message' as type,
        conversation_id as reference_id,
        sender_username,
        receiver_username,
        LEFT(message, 50) as preview,
        timestamp
      FROM chat_logs 
      ORDER BY timestamp DESC
      LIMIT $1
    `;
    
    const [conversations, messages] = await Promise.all([
      client.query(recentConversationsQuery, [limit]),
      client.query(recentMessagesQuery, [limit])
    ]);
    
    // Combine and sort by timestamp
    const activity = [...conversations.rows, ...messages.rows]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
    
    res.json({
      activity
    });
    
  } catch (error) {
    handleError(res, error, 'get recent activity');
  } finally {
    await client.end();
  }
});

// Analytics endpoints  
app.get('/api/analytics/usage', async (req, res) => {
  const client = createDBConnection();
  
  try {
    await client.connect();
    
    const days = parseInt(req.query.days) || 7;
    
    // Recent user growth (based on user_id ranges as proxy)
    const userGrowthQuery = `
      SELECT 
        'Recent' as date,
        COUNT(*) as new_users
      FROM usernames 
      WHERE user_id > (
        SELECT COALESCE(MAX(user_id) - 100, 0) FROM usernames
      )
    `;
    
    // Daily conversations
    const conversationsQuery = `
      SELECT 
        DATE(started_at AT TIME ZONE 'Asia/Jakarta') as date,
        COUNT(*) as new_conversations
      FROM conversations 
      WHERE started_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(started_at AT TIME ZONE 'Asia/Jakarta')
      ORDER BY date DESC
    `;
    
    // Daily messages
    const messagesQuery = `
      SELECT 
        DATE(timestamp AT TIME ZONE 'Asia/Jakarta') as date,
        COUNT(*) as messages
      FROM chat_logs 
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(timestamp AT TIME ZONE 'Asia/Jakarta')
      ORDER BY date DESC
    `;
    
    // Active users (users who sent messages)
    const activeUsersQuery = `
      SELECT 
        DATE(timestamp AT TIME ZONE 'Asia/Jakarta') as date,
        COUNT(DISTINCT sender_user_id) as active_users
      FROM chat_logs 
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(timestamp AT TIME ZONE 'Asia/Jakarta')
      ORDER BY date DESC
    `;
    
    const [userGrowth, conversations, messages, activeUsers] = await Promise.all([
      client.query(userGrowthQuery),
      client.query(conversationsQuery),
      client.query(messagesQuery),
      client.query(activeUsersQuery)
    ]);
    
    res.json({
      userRegistrations: userGrowth.rows,
      conversations: conversations.rows,
      messages: messages.rows,
      activeUsers: activeUsers.rows
    });
    
  } catch (error) {
    handleError(res, error, 'get usage analytics');
  } finally {
    await client.end();
  }
});

// Server setup
app.listen(PORT, () => {
  console.log(`Admin API server running on port ${PORT}`);
  console.log(`Available endpoints:`);
  console.log(`- GET /api/dashboard/stats - Dashboard statistics`);
  console.log(`- GET /api/users - Get all users with pagination`);
  console.log(`- GET /api/users/:identifier - Get user details`);
  console.log(`- GET /api/conversations - Get all conversations`);
  console.log(`- GET /api/conversations/:conversationId - Get conversation details`);
  console.log(`- GET /api/messages - Get all messages`);
  console.log(`- GET /api/users/:userId/conversations - Get user conversations`);
  console.log(`- GET /api/users/search/:query - Search users`);
  console.log(`- GET /api/activity/recent - Get recent activity`);
  console.log(`- GET /api/analytics/usage - Get usage analytics`);
});

module.exports = app;