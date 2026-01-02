# Transaction Check API

Bun-based Transaction Check API for Payment Gateway System.

## Features

- **High Performance**: Built with Bun for minimal latency
- **Redis Integration**: Direct Redis connection for fast transaction lookups
- **Compatible Response**: Matches existing payment-ui API response format
- **Health Check**: Built-in health check endpoint
- **Type Safe**: Full TypeScript support

## API Endpoints

### Check Transaction Status
```
POST /api/payment/v2/:site/:id
```

**Response:**
```json
{
  "status": true,
  "message": "",
  "data": {
    "status": "pending|sended|successed",
    "amount": 300
  }
}
```

### Health Check
```
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "redis": "connected",
  "latency_ms": 5,
  "timestamp": "2026-01-02T12:00:00.000Z"
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URI` | Redis connection string | `redis://localhost:6379` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `production` |

## Development

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint
```

## Docker

```bash
# Build image
docker build -t transaction-check-api .

# Run container
docker run -p 3000:3000 -e REDIS_URI=redis://host.docker.internal:6379 transaction-check-api
```

## Architecture

```
Request → Bun (Hono) → Redis → Response
                    ↓
              kob:transaction:{type}:{site}:{id}
```

Transaction Types:
- `deposit`: Deposit transactions
- `withdraw`: Withdraw transactions
- `settlement`: Settlement transactions

## Performance

- Average response time: <10ms (vs ~50-70ms for Node.js/NestJS)
- Memory footprint: ~50MB (vs ~200MB+ for Node.js)
- Cold start: <100ms
