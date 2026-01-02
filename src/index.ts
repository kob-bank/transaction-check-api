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

// Graceful shutdown state
let isShuttingDown = false;
const GRACEFUL_SHUTDOWN_TIMEOUT = 30000; // 30 seconds

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
redis.on('ready', () => console.log('✅ Redis ready'));
redis.on('close', () => console.log('🔌 Redis connection closed'));
redis.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('⚠️  Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🛑 Received ${signal} - Starting graceful shutdown...`);
  console.log(`${'='.repeat(60)}`);

  // Create a timeout promise
  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Graceful shutdown timeout')), GRACEFUL_SHUTDOWN_TIMEOUT);
  });

  try {
    // Step 1: Stop accepting new connections (Bun will handle this via isShuttingDown flag)
    console.log('⏹️  Stopping accepting new connections...');

    // Step 2: Wait for in-flight requests to complete (simulated - Bun handles this automatically)
    console.log('⏳ Waiting for in-flight requests to complete...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds grace period

    // Step 3: Close Redis connection
    console.log('🔌 Closing Redis connection...');
    await redis.quit();
    console.log('✅ Redis connection closed gracefully');

    console.log(`${'='.repeat(60)}`);
    console.log('✅ Graceful shutdown completed');
    console.log(`${'='.repeat(60)}\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    // Force quit if timeout or error
    await redis.disconnect().catch(() => {/* ignore */});
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Graceful start - wait for Redis to be ready
async function waitForRedis(): Promise<void> {
  const maxRetries = 30;
  const retryDelay = 1000;
  let attempts = 0;

  console.log('⏳ Waiting for Redis to be ready...');

  while (attempts < maxRetries) {
    try {
      // Check if Redis is ready
      if (redis.status === 'ready') {
        const result = await redis.ping();
        if (result === 'PONG') {
          console.log('✅ Redis is ready and responding');
          return;
        }
      }
    } catch (error) {
      // Connection not ready yet
    }

    attempts++;
    const progress = '█'.repeat(Math.min(attempts, 20)) + '░'.repeat(Math.max(20 - attempts, 0));
    process.stdout.write(`\r⏳ Progress: [${progress}] ${attempts}/${maxRetries}`);
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }

  throw new Error(`Redis not ready after ${maxRetries} attempts`);
}

// Hono app
const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-debug-key', 'x-correlation-id'],
}));

// Graceful shutdown middleware - reject requests during shutdown
app.use('*', async (c, next) => {
  if (isShuttingDown) {
    return c.json({
      status: 'error',
      message: 'Service is shutting down',
      timestamp: new Date().toISOString(),
    }, 503);
  }
  await next();
});

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
    // Pattern 1: kob:ttf:{provider}:{id}
    let transaction: TransactionData | null = null;
    let foundKey = '';

    // Check for compay-specific keys first
    const providerKey = `kob:ttf:compay:${id}`;
    const data = await redis.get(providerKey);

    if (data) {
      try {
        transaction = JSON.parse(data) as TransactionData;
        foundKey = providerKey;
        console.log(`[${debugKey}] ${correlationId} Transaction ${id} found in Redis (compay key)`);
      } catch (parseError) {
        console.error(`[${debugKey}] ${correlationId} Failed to parse transaction data from key ${providerKey}`);
      }
    }

    // If not found in compay key, try legacy pattern
    if (!transaction) {
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

// Graceful start - wait for Redis before starting server
const port = parseInt(process.env.PORT || process.env.BACKEND_PORT || '3000');

async function startServer() {
  try {
    // Wait for Redis to be ready
    await waitForRedis();

    // Server startup message
    console.log(`
╔════════════════════════════════════════════════════════╗
║  Transaction Check API (Bun)                          ║
║  Port: ${port}                                         ║
║  Redis: ${redisURI}                    ║
╚════════════════════════════════════════════════════════╝
✅ Server started successfully
🔗 Health check: http://localhost:${port}/health
💡 Press Ctrl+C to stop
`);

    // Export for Bun server
    return {
      port,
      fetch: app.fetch,
    };
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    await redis.disconnect().catch(() => {/* ignore */});
    process.exit(1);
  }
}

// Start the server
export default await startServer();
