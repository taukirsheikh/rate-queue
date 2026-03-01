/**
 * rate-queue
 *
 * A powerful rate limiter with:
 * - Concurrency control
 * - Rate limiting (minTime, maxPerInterval)
 * - Priority queues
 * - Reservoir (token bucket) pattern
 * - Task scheduling
 * - Event hooks
 * - Retry support
 * - Abort signal support
 * - Redis clustering for distributed systems
 *
 * @example
 * ```ts
 * import { RateLimiter, Priority } from 'rate-queue';
 *
 * const limiter = new RateLimiter({
 *   maxConcurrent: 5,
 *   minTime: 100,
 * });
 *
 * const result = await limiter.schedule(async () => {
 *   return await fetch('/api/data');
 * });
 * ```
 *
 * @example Distributed with Redis
 * ```ts
 * import { DistributedRateLimiter } from 'rate-queue';
 *
 * const limiter = new DistributedRateLimiter({
 *   maxConcurrent: 10,
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * await limiter.ready();
 * const result = await limiter.schedule(async () => fetchData());
 * ```
 */

// Core exports
export { RateLimiter } from './rate-limiter.js';
export { PriorityQueue } from './priority-queue.js';
export { TypedEventEmitter } from './event-emitter.js';

// Redis/distributed exports
export {
  DistributedRateLimiter,
  RedisStorage,
  type DistributedRateLimiterOptions,
  type RedisConnectionOptions,
  type AcquireResult,
  type DistributedState,
} from './redis/index.js';

// Types
export {
  Priority,
  type RateLimiterOptions,
  type JobOptions,
  type Job,
  type LimiterState,
  type Stats,
  type RateLimiterEvents,
  type EventListener,
  type OverflowStrategy,
} from './types.js';

