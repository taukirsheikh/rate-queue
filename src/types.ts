/**
 * Configuration options for the RateLimiter
 */
export interface RateLimiterOptions {
  /**
   * Maximum number of concurrent jobs
   * @default Infinity
   */
  maxConcurrent?: number;

  /**
   * Minimum time between job starts (in milliseconds)
   * @default 0
   */
  minTime?: number;

  /**
   * Maximum number of jobs per interval
   * Used together with `interval`
   * @default Infinity
   */
  maxPerInterval?: number;

  /**
   * Time window for maxPerInterval (in milliseconds)
   * @default 1000
   */
  interval?: number;

  /**
   * Initial reservoir size (token bucket)
   * When set, limits total executions until refilled
   * @default Infinity
   */
  reservoir?: number;

  /**
   * How often to refill the reservoir (in milliseconds)
   * @default null (no automatic refill)
   */
  reservoirRefreshInterval?: number | null;

  /**
   * Amount to refill the reservoir to
   * @default reservoir initial value
   */
  reservoirRefreshAmount?: number;

  /**
   * Whether to use high resolution timestamps
   * @default false
   */
  highWater?: number;

  /**
   * Strategy when highWater is reached
   * @default 'leak'
   */
  strategy?: OverflowStrategy;

  /**
   * Timeout for individual jobs (in milliseconds)
   * @default null (no timeout)
   */
  timeout?: number | null;

  /**
   * Retry failed jobs automatically
   * @default 0
   */
  retryCount?: number;

  /**
   * Delay between retries (in milliseconds)
   * @default 0
   */
  retryDelay?: number | ((attempt: number, error: Error) => number);

  /**
   * ID for this limiter instance
   * @default auto-generated
   */
  id?: string;
}

/**
 * Strategy for handling queue overflow
 */
export type OverflowStrategy = 'leak' | 'overflow' | 'block';

/**
 * Job priority levels
 */
export enum Priority {
  CRITICAL = 0,
  HIGH = 3,
  NORMAL = 5,
  LOW = 7,
  IDLE = 9,
}

/**
 * Options for scheduling a job
 */
export interface JobOptions {
  /**
   * Job priority (lower = higher priority).
   * Can be a number or a function called at enqueue time (e.g. for dynamic priority from user, time, etc.).
   * @default Priority.NORMAL (5)
   */
  priority?: number | (() => number);

  /**
   * Job weight (uses this many concurrent slots)
   * @default 1
   */
  weight?: number;

  /**
   * Unique job ID
   * @default auto-generated
   */
  id?: string;

  /**
   * Custom timeout for this job (overrides limiter timeout)
   */
  timeout?: number | null;

  /**
   * Custom retry count for this job
   */
  retryCount?: number;

  /**
   * Abort signal for cancellation
   */
  signal?: AbortSignal;
}

/**
 * Internal job representation
 */
export interface Job<T = unknown> {
  id: string;
  priority: number;
  weight: number;
  timeout: number | null;
  retryCount: number;
  retryAttempt: number;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  queuedAt: number;
  startedAt?: number;
}

/**
 * Limiter state
 */
export interface LimiterState {
  running: number;
  queued: number;
  done: number;
  failed: number;
  reservoir: number | null;
}

/**
 * Event types emitted by the rate limiter
 */
export type RateLimiterEvents = {
  /** Emitted when a job starts executing */
  executing: { job: Job; queued: number; running: number };
  /** Emitted when a job completes successfully */
  done: { job: Job; result: unknown; duration: number };
  /** Emitted when a job fails */
  failed: { job: Job; error: Error; willRetry: boolean };
  /** Emitted when a job is retried */
  retry: { job: Job; attempt: number; error: Error };
  /** Emitted when a job is queued */
  queued: { job: Job; position: number };
  /** Emitted when a job is dropped (overflow) */
  dropped: { job: Job; reason: string };
  /** Emitted when the limiter becomes idle */
  idle: void;
  /** Emitted when the limiter is depleted (reservoir empty) */
  depleted: void;
  /** Emitted on any error */
  error: Error;
};

/**
 * Typed event listener
 */
export type EventListener<T> = (data: T) => void;

/**
 * Stats snapshot
 */
export interface Stats {
  running: number;
  queued: number;
  done: number;
  failed: number;
  reservoir: number | null;
  avgWaitTime: number;
  avgExecutionTime: number;
}

