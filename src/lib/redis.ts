import { Redis } from '@upstash/redis';

const globalForRedis = globalThis as unknown as { __redis?: Redis | null };

export function getRedis(): Redis | null {
  if (globalForRedis.__redis === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      globalForRedis.__redis = new Redis({ url, token });
    } else {
      globalForRedis.__redis = null;
    }
  }
  return globalForRedis.__redis;
}

export const redis = getRedis();
