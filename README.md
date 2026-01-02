# Transaction Check API

Bun-based Transaction Check API for Payment Gateway System.

## Features

- **High Performance**: Built with Bun for minimal latency
- **Redis Integration**: Direct Redis connection for fast transaction lookups
- **Compatible Response**: Matches existing payment-ui API response format
- **Health Check**: Built-in health check endpoint
- **Type Safe**: Full TypeScript support
- **CI/CD**: Automated builds to DigitalOcean Container Registry

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
```

## Deployment

### DigitalOcean Container Registry (DOCR)

#### 1. Set up GitHub Secrets

Add these secrets to your GitHub repository (`Settings` → `Secrets and variables` → `Actions`):

| Secret | Value |
|--------|-------|
| `DIGITALOCEAN_ACCESS_TOKEN` | Your DigitalOcean API token |
| `DIGITALOCEAN_REPOSITORY` | Your DOCR repository name (e.g., `kob-bank`) |

#### 2. CI/CD Pipeline

On push to `main` or `develop`, the workflow will:
1. Run tests with Redis service
2. Type check the code
3. Build and push Docker image to DOCR

**Image format**: `registry.digitalocean.com/{REPOSITORY}/transaction-check-api:latest`

#### 3. Deploy to Kubernetes

```bash
# Add the Helm repository
helm repo add transaction-check-api ./chart

# Install/upgrade the chart
helm upgrade --install transaction-check-api ./chart \
  --namespace payment-production \
  --create-namespace \
  --set IMAGE_REPOSITORY=kob-bank \
  --set IMAGE_NAME=transaction-check-api \
  --set image.tag=latest \
  --set REDIS_URI=redis://redis-service:6379
```

### Using Rancher

1. Go to your Rancher cluster
2. Click `Apps` → `Create`
3. Select `transaction-check-api` chart
4. Fill in the required values:
   - **Image Repository**: `kob-bank`
   - **Image Name**: `transaction-check-api`
   - **Image Tag**: `latest`
   - **Redis URI**: Your Redis connection string

### Docker (Local)

```bash
# Build image
docker build -t transaction-check-api .

# Run container
docker run -p 3000:3000 \
  -e REDIS_URI=redis://host.docker.internal:6379 \
  transaction-check-api
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

## CI/CD Badge

[![CI](https://github.com/kob-bank/transaction-check-api/actions/workflows/CI.yml/badge.svg)](https://github.com/kob-bank/transaction-check-api/actions/workflows/CI.yml)
