import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import Redis from 'ioredis';

// Types
interface TransactionData {
  status: string;
  amount: number;
  type?: string;
  site?: string;
  username?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface TransactionResponse {
  status: boolean;
  message: string;
  data: {
    status: string;
    amount: number;
  };
}

// Constants
const KEY_PREFIX = 'kob:transaction';
const TRANSACTION_TYPES = ['deposit', 'withdraw', 'settlement'] as const;

// Redis client
const redisURI = process.env.REDIS_URI || process.env.BACKEND_REDIS_URI || 'redis://localhost:6379';
const redis = new Redis(redisURI, {
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => err.message?.includes('READONLY') || false,
  autoResubscribe: true,
  autoResendUnfulfilledCommands: true,
  lazyConnect: false,
  connectTimeout: 10000,
  commandTimeout: 5000,
});

// Log Redis connection
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// Hono app
const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-debug-key', 'x-correlation-id'],
}));

// Health check endpoint
app.get('/health', async (c) => {
  try {
    const startTime = Date.now();
    await redis.ping();
    const duration = Date.now() - startTime;

    return c.json({
      status: 'healthy',
      redis: 'connected',
      latency_ms: duration,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      redis: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// Transaction check endpoint - v2
// POST /api/payment/v2/:site/:id
app.post('/api/payment/v2/:site/:id', async (c) => {
  const site = c.req.param('site');
  const id = c.req.param('id');
  const debugKey = c.req.header('x-debug-key') || 'N/A';
  const correlationId = c.req.header('x-correlation-id') || crypto.randomUUID();

  console.log(`[${debugKey}] ${correlationId} Checking transaction ${id} for site ${site}`);

  try {
    // Try to find transaction in Redis
    // Try all transaction types
    let transaction: TransactionData | null = null;
    let foundKey = '';

    for (const type of TRANSACTION_TYPES) {
      const key = `${KEY_PREFIX}:${type}:${site}:${id}`;
      const data = await redis.get(key);

      if (data) {
        try {
          transaction = JSON.parse(data) as TransactionData;
          foundKey = key;
          console.log(`[${debugKey}] ${correlationId} Transaction ${id} found in Redis (${type})`);
          break;
        } catch (parseError) {
          console.error(`[${debugKey}] ${correlationId} Failed to parse transaction data from key ${key}`);
        }
      }
    }

    if (transaction) {
      // Map status to lowercase
      let status = transaction.status?.toLowerCase() || 'pending';

      // Map "created" to "pending" for consistency
      if (status === 'created') {
        status = 'pending';
      }

      const response: TransactionResponse = {
        status: true,
        message: '',
        data: {
          status,
          amount: transaction.amount || 0,
        },
      };

      console.log(`[${debugKey}] ${correlationId} Returning status: ${status}, amount: ${transaction.amount}`);
      return c.json(response);
    }

    // Transaction not found - return pending status
    console.log(`[${debugKey}] ${correlationId} Transaction ${id} not found in Redis, returning pending`);

    const notFoundResponse: TransactionResponse = {
      status: true,
      message: '',
      data: {
        status: 'pending',
        amount: 0,
      },
    };

    return c.json(notFoundResponse);
  } catch (error) {
    console.error(`[${debugKey}] ${correlationId} Error checking transaction:`, error);

    // On error, return pending status for resilience
    const errorResponse: TransactionResponse = {
      status: true,
      message: '',
      data: {
        status: 'pending',
        amount: 0,
      },
    };

    return c.json(errorResponse);
  }
});

// Start server
const port = parseInt(process.env.PORT || process.env.BACKEND_PORT || '3000');

console.log(`
╔════════════════════════════════════════════════════════╗
║  Transaction Check API (Bun)                          ║
║  Port: ${port}                                         ║
║  Redis: ${redisURI}                    ║
╚════════════════════════════════════════════════════════╝
`);

export default {
  port,
  fetch: app.fetch,
};
