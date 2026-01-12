import bcrypt from 'bcryptjs';

export default {
  async register(ctx) {
    try {
      const { name, email, phone, password } = ctx.request.body;

      // Validate input
      if (!name || !email || !password) {
        return ctx.badRequest('Name, email and password are required');
      }

      // Check if client already exists
      const existingClient = await strapi.db.query('api::client.client').findOne({
        where: {
          $or: [
            { email },
            { phone: phone || null },
          ],
        },
      });

      if (existingClient) {
        return ctx.badRequest('Client with this email or phone already exists');
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create new client
      const client = await strapi.db.query('api::client.client').create({
        data: {
          name,
          email,
          phone: phone || null,
          password: hashedPassword,
          sum: 0,
          loyaltyPoints: 0,
          loyaltyYear: 2026,
          registrationDate: new Date(),
          isActive: true,
          publishedAt: new Date(),
        },
      });

      // Remove password from response
      const { password: _, ...clientData } = client;

      // Generate simple token (in production, use JWT)
      const token = Buffer.from(`${client.id}:${client.email}`).toString('base64');

      ctx.send({
        client: clientData,
        token,
      });
    } catch (error) {
      console.error('Registration error:', error);
      ctx.internalServerError('Registration failed');
    }
  },

  async login(ctx) {
    try {
      const { email, password } = ctx.request.body;

      if (!email || !password) {
        return ctx.badRequest('Email and password are required');
      }

      // Find client
      const client = await strapi.db.query('api::client.client').findOne({
        where: { email },
      });

      if (!client) {
        return ctx.badRequest('Invalid credentials');
      }

      // Check if client is active
      if (!client.isActive) {
        return ctx.forbidden('Account is not active');
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, client.password);

      if (!isValidPassword) {
        return ctx.badRequest('Invalid credentials');
      }

      // Remove password from response
      const { password: _, ...clientData } = client;

      // Generate token
      const token = Buffer.from(`${client.id}:${client.email}`).toString('base64');

      ctx.send({
        client: clientData,
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      ctx.internalServerError('Login failed');
    }
  },

  async me(ctx) {
    try {
      // Extract token from Authorization header
      const authHeader = ctx.request.header.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return ctx.unauthorized('No token provided');
      }

      const token = authHeader.split(' ')[1];
      const decoded = Buffer.from(token, 'base64').toString();
      const [clientId] = decoded.split(':');

      // Get client with relations
      const client = await strapi.db.query('api::client.client').findOne({
        where: { id: clientId },
        populate: {
          offers: {
            populate: {
              offer: true,
              personal: true,
            },
          },
          loyaltyTransactions: {
            orderBy: { date: 'desc' },
            limit: 50,
          },
        },
      });

      if (!client) {
        return ctx.notFound('Client not found');
      }

      // Remove password
      const { password: _, ...clientData } = client;

      ctx.send(clientData);
    } catch (error) {
      console.error('Me error:', error);
      ctx.unauthorized('Invalid token');
    }
  },

  async getStatus(ctx) {
    try {
      const { clientId } = ctx.params;

      const client = await strapi.db.query('api::client.client').findOne({
        where: { id: clientId },
        populate: {
          offers: true,
        },
      });

      if (!client) {
        return ctx.notFound('Client not found');
      }

      // Calculate loyalty status based on spending
      const totalSpent = parseInt(client.sum || 0);
      const circles = Math.floor(totalSpent / 1000);

      // Define rewards based on spending
      const rewards = [];

      if (totalSpent >= 3000) {
        rewards.push({
          type: 'discount_percent',
          value: 20,
          unlocked: true,
          title: '20% скидка',
          description: 'Скидка 20% на услуги',
        });
      }

      if (totalSpent >= 5000) {
        rewards.push({
          type: 'voucher',
          value: 400,
          unlocked: true,
          title: '400 Kč ваучер',
          description: 'Ваучер на 400 крон',
        });
      }

      if (totalSpent >= 8000) {
        rewards.push({
          type: 'discount_percent',
          value: 50,
          unlocked: true,
          title: '50% скидка на полировку',
          description: 'Скидка 50% на полировку',
        });
      }

      // Next reward
      let nextReward = null;
      if (totalSpent < 3000) {
        nextReward = {
          type: 'discount_percent',
          value: 20,
          required: 3000,
          remaining: 3000 - totalSpent,
          title: '20% скидка',
        };
      } else if (totalSpent < 5000) {
        nextReward = {
          type: 'voucher',
          value: 400,
          required: 5000,
          remaining: 5000 - totalSpent,
          title: '400 Kč ваучер',
        };
      } else if (totalSpent < 8000) {
        nextReward = {
          type: 'discount_percent',
          value: 50,
          required: 8000,
          remaining: 8000 - totalSpent,
          title: '50% скидка на полировку',
        };
      }

      ctx.send({
        totalSpent,
        circles,
        loyaltyPoints: client.loyaltyPoints,
        year: client.loyaltyYear,
        rewards,
        nextReward,
        progress: Math.min((totalSpent / 8000) * 100, 100),
      });
    } catch (error) {
      console.error('Get status error:', error);
      ctx.internalServerError('Failed to get status');
    }
  },

  async getRewards(ctx) {
    try {
      const rewards = await strapi.db.query('api::loyalty-reward.loyalty-reward').findMany({
        where: {
          isActive: true,
          year: 2026,
        },
        orderBy: { order: 'asc' },
      });

      ctx.send(rewards);
    } catch (error) {
      console.error('Get rewards error:', error);
      ctx.internalServerError('Failed to get rewards');
    }
  },

  async calculatePoints(ctx) {
    try {
      const { clientId, amount } = ctx.request.body;

      if (!clientId || !amount) {
        return ctx.badRequest('Client ID and amount are required');
      }

      const client = await strapi.db.query('api::client.client').findOne({
        where: { id: clientId },
      });

      if (!client) {
        return ctx.notFound('Client not found');
      }

      // 1000 Kč = 1 circle
      const circles = Math.floor(amount / 1000);

      ctx.send({
        amount,
        circles,
        totalCircles: Math.floor((parseInt(client.sum) + amount) / 1000),
      });
    } catch (error) {
      console.error('Calculate points error:', error);
      ctx.internalServerError('Calculation failed');
    }
  },
};