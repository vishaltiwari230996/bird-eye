import type { PlatformAdapter } from './types';
import { amazonAdapter } from './amazon';
import { flipkartAdapter } from './flipkart';

const adapters: Record<string, PlatformAdapter> = {
  amazon: amazonAdapter,
  flipkart: flipkartAdapter,
};

export function getAdapter(platform: string): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
  return adapter;
}

export type { PlatformAdapter, Product, FetchResult, NormalizedPayload } from './types';
