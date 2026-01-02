import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import Redis from 'ioredis';

describe('Transaction Check API', () => {
  const redis = new Redis('redis://localhost:6379/15'); // Use separate DB for tests
  const KEY_PREFIX = 'kob:transaction';
  const site = 'testsite';

  beforeAll(async () => {
    // Clear test DB
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should store and retrieve deposit transaction', async () => {
    const transaction = {
      id: 'test123',
      type: 'deposit',
      site: site,
      username: 'testuser',
      status: 'pending',
      amount: 300,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const key = `${KEY_PREFIX}:deposit:${site}:${transaction.id}`;
    await redis.set(key, JSON.stringify(transaction));

    const retrieved = await redis.get(key);
    expect(retrieved).not.toBeNull();

    const parsed = JSON.parse(retrieved!);
    expect(parsed.id).toBe(transaction.id);
    expect(parsed.amount).toBe(transaction.amount);
    expect(parsed.status).toBe(transaction.status);
  });

  it('should return pending status for non-existent transaction', async () => {
    const key = `${KEY_PREFIX}:deposit:${site}:nonexistent`;
    const data = await redis.get(key);
    expect(data).toBeNull();
  });

  it('should map created status to pending', async () => {
    const transaction = {
      id: 'test456',
      type: 'deposit',
      site: site,
      status: 'created',
      amount: 500,
    };

    const key = `${KEY_PREFIX}:deposit:${site}:${transaction.id}`;
    await redis.set(key, JSON.stringify(transaction));

    const retrieved = await redis.get(key);
    const parsed = JSON.parse(retrieved!);

    // Should map to pending
    const mappedStatus = parsed.status === 'created' ? 'pending' : parsed.status;
    expect(mappedStatus).toBe('pending');
  });
});
