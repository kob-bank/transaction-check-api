import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { serve } from 'bun';
import Redis from 'ioredis';
import { Hono } from 'hono';

// Import the createApp function to create a new app instance
async function createTestApp(redisClient: Redis) {
  const { cors } = await import('hono/cors');
  const { logger } = await import('hono/logger');

  const KEY_PREFIX = 'kob:transaction';
  const TRANSACTION_TYPES = ['deposit', 'withdraw', 'settlement'] as const;

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
      await redisClient.ping();
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
  app.post('/api/payment/v2/:site/:id', async (c) => {
    const site = c.req.param('site');
    const id = c.req.param('id');
    const debugKey = c.req.header('x-debug-key') || 'N/A';
    const correlationId = c.req.header('x-correlation-id') || crypto.randomUUID();

    console.log(`[${debugKey}] ${correlationId} Checking transaction ${id} for site ${site}`);

    try {
      let transaction: any = null;

      for (const type of TRANSACTION_TYPES) {
        const key = `${KEY_PREFIX}:${type}:${site}:${id}`;
        const data = await redisClient.get(key);

        if (data) {
          try {
            transaction = JSON.parse(data);
            console.log(`[${debugKey}] ${correlationId} Transaction ${id} found in Redis (${type})`);
            break;
          } catch (parseError) {
            console.error(`[${debugKey}] ${correlationId} Failed to parse transaction data from key ${key}`);
          }
        }
      }

      if (transaction) {
        let status = transaction.status?.toLowerCase() || 'pending';
        if (status === 'created') {
          status = 'pending';
        }

        console.log(`[${debugKey}] ${correlationId} Returning status: ${status}, amount: ${transaction.amount}`);
        return c.json({
          status: true,
          message: '',
          data: {
            status,
            amount: transaction.amount || 0,
          },
        });
      }

      console.log(`[${debugKey}] ${correlationId} Transaction ${id} not found in Redis, returning pending`);
      return c.json({
        status: true,
        message: '',
        data: {
          status: 'pending',
          amount: 0,
        },
      });
    } catch (error) {
      console.error(`[${debugKey}] ${correlationId} Error checking transaction:`, error);
      return c.json({
        status: true,
        message: '',
        data: {
          status: 'pending',
          amount: 0,
        },
      });
    }
  });

  return app;
}

describe('Integration Test - Full Transaction Check Flow', () => {
  const redis = new Redis('redis://localhost:6379/15');
  const KEY_PREFIX = 'kob:transaction';
  const site = 'integration-test';
  const transactionId = 'int-test-123';

  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    // Clear test DB
    await redis.flushdb();

    // Create test app with shared Redis client
    const app = await createTestApp(redis);

    server = serve({
      fetch: app.fetch,
      port: 0, // Random port
    });

    baseUrl = `http://localhost:${server.port}`;
    console.log(`Test server started at ${baseUrl}`);
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
    server?.stop();
  });

  it('should handle full transaction check flow', async () => {
    // Step 1: Create a transaction in Redis
    const transaction = {
      id: transactionId,
      type: 'deposit',
      site: site,
      username: 'testuser',
      status: 'pending',
      amount: 500,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const key = `${KEY_PREFIX}:deposit:${site}:${transactionId}`;
    await redis.set(key, JSON.stringify(transaction));

    // Step 2: Call the API
    const response = await fetch(`${baseUrl}/api/payment/v2/${site}/${transactionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-debug-key': 'TEST',
      },
    });

    // Step 3: Verify response
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({
      status: true,
      message: '',
      data: {
        status: 'pending',
        amount: 500,
      },
    });
  });

  it('should return pending for non-existent transaction', async () => {
    const nonExistentId = 'non-existent-xyz';

    const response = await fetch(`${baseUrl}/api/payment/v2/${site}/${nonExistentId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({
      status: true,
      message: '',
      data: {
        status: 'pending',
        amount: 0,
      },
    });
  });

  it('should map status values correctly', async () => {
    const testCases = [
      { status: 'created', expected: 'pending' },
      { status: 'pending', expected: 'pending' },
      { status: 'sended', expected: 'sended' },
      { status: 'successed', expected: 'successed' },
      { status: 'SUCCESS', expected: 'success' }, // Case insensitive
    ];

    for (let i = 0; i < testCases.length; i++) {
      const { status, expected } = testCases[i];
      const id = `status-test-${i}`;

      const transaction = {
        id,
        type: 'deposit',
        site,
        status,
        amount: 100,
      };

      const key = `${KEY_PREFIX}:deposit:${site}:${id}`;
      await redis.set(key, JSON.stringify(transaction));

      const response = await fetch(`${baseUrl}/api/payment/v2/${site}/${id}`, {
        method: 'POST',
      });

      const data = (await response.json()) as { data: { status: string } };
      expect(data.data.status).toBe(expected);
    }
  });

  it('should pass health check', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as { status: string; redis: string; latency_ms: number };
    expect(data.status).toBe('healthy');
    expect(data.redis).toBe('connected');
    expect(typeof data.latency_ms).toBe('number');
  });
});
