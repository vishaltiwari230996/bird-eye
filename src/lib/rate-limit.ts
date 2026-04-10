import { getRedis } from './redis';
import { log } from './logger';

interface RateLimitConfig {
  /** Max tokens in the bucket */
  maxTokens: number;
  /** Tokens refilled per second */
  refillRate: number;
  /** Redis key prefix */
  keyPrefix: string;
}

const PLATFORM_LIMITS: Record<string, RateLimitConfig> = {
  amazon: { maxTokens: 5, refillRate: 0.5, keyPrefix: 'rl:amazon' },
  flipkart: { maxTokens: 5, refillRate: 0.5, keyPrefix: 'rl:flipkart' },
};

/**
 * Token-bucket rate limiter backed by Upstash Redis.
 * Returns true if the request is allowed, false if rate-limited.
 */
export async function consumeToken(platform: string): Promise<boolean> {
  const config = PLATFORM_LIMITS[platform];
  if (!config) return true;

  const key = config.keyPrefix;
  const now = Date.now();

  // Atomic Lua token bucket
  const script = `
    local key = KEYS[1]
    local max = tonumber(ARGV[1])
    local refill = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local data = redis.call('HMGET', key, 'tokens', 'ts')
    local tokens = tonumber(data[1])
    local lastTs = tonumber(data[2])

    if tokens == nil then
      tokens = max
      lastTs = now
    end

    local elapsed = (now - lastTs) / 1000
    tokens = math.min(max, tokens + elapsed * refill)
    lastTs = now

    if tokens >= 1 then
      tokens = tokens - 1
      redis.call('HMSET', key, 'tokens', tokens, 'ts', lastTs)
      redis.call('EXPIRE', key, 300)
      return 1
    else
      redis.call('HMSET', key, 'tokens', tokens, 'ts', lastTs)
      redis.call('EXPIRE', key, 300)
      return 0
    end
  `;

  const redis = getRedis();
  if (!redis) {
    log.debug('Redis not configured, skipping rate limit');
    return true;
  }

  try {
    const result = await redis.eval(
      script,
      [key],
      [config.maxTokens, config.refillRate, now],
    );
    const allowed = result === 1;
    if (!allowed) {
      log.warn('Rate limited', { platform });
    }
    return allowed;
  } catch (err) {
    log.error('Rate limiter error, allowing request', { platform, error: String(err) });
    return true; // fail-open
  }
}

/** Add a small random delay (200–800ms) to be polite */
export function politeDelay(): Promise<void> {
  const ms = 200 + Math.random() * 600;
  return new Promise((r) => setTimeout(r, ms));
}
