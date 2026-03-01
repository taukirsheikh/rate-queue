import { TypedEventEmitter } from './event-emitter.js';
import { PriorityQueue } from './priority-queue.js';
import type {
  Job,
  JobOptions,
  LimiterState,
  RateLimiterOptions,
  Stats,
  Priority,
} from './types.js';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise that rejects after specified ms
 */
function createTimeout(ms: number, jobId: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Job "${jobId}" timed out after ${ms}ms`));
    }, ms);
  });
}

/**
 * RateLimiter - A powerful task scheduler with concurrency control,
 * rate limiting, priority queues, and reservoir (token bucket) pattern.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter({
 *   maxConcurrent: 2,
 *   minTime: 100,
 *   maxPerInterval: 10,
 *   interval: 1000,
 * });
 *
 * // Schedule a job
 * const result = await limiter.schedule(async () => {
 *   return await fetch('https://api.example.com/data');
 * });
 *
 * // With priority
 * const urgent = await limiter.schedule(
 *   { priority: Priority.HIGH },
 *   async () => fetchCriticalData()
 * );
 * ```
 */
export class RateLimiter extends TypedEventEmitter {
  readonly id: string;

  // Configuration
  private readonly maxConcurrent: number;
  private readonly minTime: number;
  private readonly maxPerInterval: number;
  private readonly interval: number;
  private readonly highWater: number;
  private readonly strategy: 'leak' | 'overflow' | 'block';
  private readonly defaultTimeout: number | null;
  private readonly defaultRetryCount: number;
  private readonly defaultRetryDelay: number | ((attempt: number, error: Error) => number);

  // Reservoir
  private reservoir: number | null;
  private readonly reservoirRefreshInterval: number | null;
  private readonly reservoirRefreshAmount: number;
  private reservoirRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // State
  private readonly queue = new PriorityQueue();
  private running = 0;
  private currentWeight = 0;
  private done = 0;
  private failed = 0;
  private lastJobTime = 0;
  private intervalStart = 0;
  private intervalCount = 0;
  private paused = false;
  private stopped = false;

  // Stats tracking
  private totalWaitTime = 0;
  private totalExecutionTime = 0;
  private completedJobs = 0;

  // Active jobs for cancellation
  private readonly activeJobs = new Map<string, Job>();

  constructor(options: RateLimiterOptions = {}) {
    super();

    this.id = options.id ?? generateId();
    this.maxConcurrent = options.maxConcurrent ?? Infinity;
    this.minTime = options.minTime ?? 0;
    this.maxPerInterval = options.maxPerInterval ?? Infinity;
    this.interval = options.interval ?? 1000;
    this.highWater = options.highWater ?? Infinity;
    this.strategy = options.strategy ?? 'leak';
    this.defaultTimeout = options.timeout ?? null;
    this.defaultRetryCount = options.retryCount ?? 0;
    this.defaultRetryDelay = options.retryDelay ?? 0;

    // Reservoir setup
    this.reservoir = options.reservoir ?? null;
    this.reservoirRefreshInterval = options.reservoirRefreshInterval ?? null;
    this.reservoirRefreshAmount = options.reservoirRefreshAmount ?? (options.reservoir ?? 0);

    // Start reservoir refresh if configured
    if (this.reservoirRefreshInterval !== null && this.reservoir !== null) {
      this.reservoirRefreshTimer = setInterval(() => {
        this.reservoir = this.reservoirRefreshAmount;
        this.tryProcess();
      }, this.reservoirRefreshInterval);
    }
  }

  /**
   * Schedule a job for execution
   */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
  schedule<T>(options: JobOptions, fn: () => Promise<T>): Promise<T>;
  schedule<T>(
    optionsOrFn: JobOptions | (() => Promise<T>),
    maybeFn?: () => Promise<T>
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('Limiter has been stopped'));
    }

    const options: JobOptions = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

    const resolvedPriority =
      typeof options.priority === 'function' ? options.priority() : (options.priority ?? 5);

    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: options.id ?? generateId(),
        priority: resolvedPriority,
        weight: options.weight ?? 1,
        timeout: options.timeout !== undefined ? options.timeout : this.defaultTimeout,
        retryCount: options.retryCount ?? this.defaultRetryCount,
        retryAttempt: 0,
        fn,
        resolve,
        reject,
        signal: options.signal,
        queuedAt: Date.now(),
      };

      // Check abort signal
      if (job.signal?.aborted) {
        reject(new Error('Job was aborted'));
        return;
      }

      // Handle abort signal
      if (job.signal) {
        job.signal.addEventListener(
          'abort',
          () => {
            if (this.queue.has(job.id)) {
              this.queue.removeById(job.id);
              reject(new Error('Job was aborted'));
            }
          },
          { once: true }
        );
      }

      // Check high water mark
      if (this.queue.size >= this.highWater) {
        switch (this.strategy) {
          case 'leak':
            // Drop oldest low-priority job
            const dropped = this.dropLowestPriorityJob();
            if (dropped) {
              this.emit('dropped', { job: dropped as Job, reason: 'highWater exceeded' });
            }
            break;
          case 'overflow':
            // Reject new job
            this.emit('dropped', { job: job as Job, reason: 'highWater exceeded' });
            reject(new Error('Queue overflow: highWater exceeded'));
            return;
          case 'block':
            // Just queue it anyway (blocking mode)
            break;
        }
      }

      // Add to queue
      const position = this.queue.enqueue(job as Job);
      this.emit('queued', { job: job as Job, position });

      // Try to process
      this.tryProcess();
    });
  }

  /**
   * Wrap a function to be rate-limited
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options?: JobOptions
  ): (...args: TArgs) => Promise<TResult> {
    return (...args: TArgs) => {
      return this.schedule(options ?? {}, () => fn(...args));
    };
  }

  /**
   * Schedule multiple jobs
   */
  scheduleAll<T>(jobs: Array<{ fn: () => Promise<T>; options?: JobOptions }>): Promise<T[]> {
    return Promise.all(
      jobs.map(({ fn, options }) => this.schedule(options ?? {}, fn))
    );
  }

  /**
   * Pause job processing
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume job processing
   */
  resume(): void {
    this.paused = false;
    this.tryProcess();
  }

  /**
   * Stop the limiter and reject all pending jobs
   */
  stop(): Promise<void> {
    this.stopped = true;

    // Clear reservoir refresh
    if (this.reservoirRefreshTimer) {
      clearInterval(this.reservoirRefreshTimer);
      this.reservoirRefreshTimer = null;
    }

    // Reject all queued jobs
    const error = new Error('Limiter was stopped');
    while (!this.queue.isEmpty) {
      const job = this.queue.dequeue()!;
      job.reject(error);
    }

    // Wait for running jobs to complete
    return this.waitForIdle();
  }

  /**
   * Wait for all jobs to complete
   */
  async waitForIdle(): Promise<void> {
    if (this.running === 0 && this.queue.isEmpty) {
      return;
    }

    return new Promise((resolve) => {
      const check = () => {
        if (this.running === 0 && this.queue.isEmpty) {
          resolve();
        } else {
          this.once('done', check);
          this.once('failed', check);
        }
      };
      check();
    });
  }

  /**
   * Get current limiter state
   */
  getState(): LimiterState {
    return {
      running: this.running,
      queued: this.queue.size,
      done: this.done,
      failed: this.failed,
      reservoir: this.reservoir,
    };
  }

  /**
   * Get detailed statistics
   */
  getStats(): Stats {
    return {
      ...this.getState(),
      avgWaitTime: this.completedJobs > 0 ? this.totalWaitTime / this.completedJobs : 0,
      avgExecutionTime: this.completedJobs > 0 ? this.totalExecutionTime / this.completedJobs : 0,
    };
  }

  /**
   * Check if the limiter is idle
   */
  isIdle(): boolean {
    return this.running === 0 && this.queue.isEmpty;
  }

  /**
   * Get queued jobs
   */
  getQueued(): readonly Job[] {
    return this.queue.toArray();
  }

  /**
   * Update reservoir value
   */
  updateReservoir(value: number): void {
    this.reservoir = value;
    this.tryProcess();
  }

  /**
   * Increment reservoir
   */
  incrementReservoir(amount: number): void {
    if (this.reservoir !== null) {
      this.reservoir += amount;
      this.tryProcess();
    }
  }

  /**
   * Cancel a specific job by ID
   */
  cancel(jobId: string): boolean {
    const job = this.queue.removeById(jobId);
    if (job) {
      job.reject(new Error('Job was cancelled'));
      return true;
    }
    return false;
  }

  /**
   * Try to process jobs from the queue
   */
  private tryProcess(): void {
    if (this.paused || this.stopped) return;

    while (this.canProcessNext()) {
      const job = this.queue.dequeue();
      if (!job) break;
      this.executeJob(job);
    }

    // Emit idle if nothing running
    if (this.running === 0 && this.queue.isEmpty) {
      this.emit('idle', undefined);
    }
  }

  /**
   * Check if we can process the next job
   */
  private canProcessNext(): boolean {
    if (this.queue.isEmpty) return false;

    const nextJob = this.queue.peek();
    if (!nextJob) return false;

    // Check concurrency
    if (this.currentWeight + nextJob.weight > this.maxConcurrent) {
      return false;
    }

    // Check reservoir
    if (this.reservoir !== null && this.reservoir <= 0) {
      this.emit('depleted', undefined);
      return false;
    }

    // Check interval rate limit
    const now = Date.now();
    if (now - this.intervalStart >= this.interval) {
      // New interval
      this.intervalStart = now;
      this.intervalCount = 0;
    }
    if (this.intervalCount >= this.maxPerInterval) {
      // Schedule retry when interval resets
      const timeUntilReset = this.interval - (now - this.intervalStart);
      setTimeout(() => this.tryProcess(), timeUntilReset + 1);
      return false;
    }

    // Check minTime
    const timeSinceLastJob = now - this.lastJobTime;
    if (timeSinceLastJob < this.minTime) {
      // Schedule retry after minTime
      setTimeout(() => this.tryProcess(), this.minTime - timeSinceLastJob + 1);
      return false;
    }

    return true;
  }

  /**
   * Execute a single job
   */
  private async executeJob(job: Job): Promise<void> {
    // Update state
    this.running++;
    this.currentWeight += job.weight;
    this.lastJobTime = Date.now();
    this.intervalCount++;

    // Decrement reservoir
    if (this.reservoir !== null) {
      this.reservoir--;
    }

    job.startedAt = Date.now();
    this.activeJobs.set(job.id, job);

    this.emit('executing', {
      job,
      queued: this.queue.size,
      running: this.running,
    });

    const waitTime = job.startedAt - job.queuedAt;
    const startTime = Date.now();

    try {
      // Check if aborted
      if (job.signal?.aborted) {
        throw new Error('Job was aborted');
      }

      // Execute with optional timeout
      let result: unknown;
      if (job.timeout !== null) {
        result = await Promise.race([job.fn(), createTimeout(job.timeout, job.id)]);
      } else {
        result = await job.fn();
      }

      const duration = Date.now() - startTime;

      // Update stats
      this.totalWaitTime += waitTime;
      this.totalExecutionTime += duration;
      this.completedJobs++;
      this.done++;

      this.emit('done', { job, result, duration });
      job.resolve(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Check for retry
      if (job.retryAttempt < job.retryCount) {
        job.retryAttempt++;
        this.emit('retry', { job, attempt: job.retryAttempt, error: err });

        // Calculate retry delay
        let delay: number;
        if (typeof this.defaultRetryDelay === 'function') {
          delay = this.defaultRetryDelay(job.retryAttempt, err);
        } else {
          delay = this.defaultRetryDelay;
        }

        // Re-queue after delay
        setTimeout(() => {
          job.queuedAt = Date.now();
          this.queue.enqueue(job);
          this.tryProcess();
        }, delay);

        this.emit('failed', { job, error: err, willRetry: true });
      } else {
        this.failed++;
        this.emit('failed', { job, error: err, willRetry: false });
        this.emit('error', err);
        job.reject(err);
      }
    } finally {
      this.running--;
      this.currentWeight -= job.weight;
      this.activeJobs.delete(job.id);

      // Try to process more
      this.tryProcess();
    }
  }

  /**
   * Drop the lowest priority job from the queue
   */
  private dropLowestPriorityJob(): Job | undefined {
    const jobs = this.queue.toArray();
    if (jobs.length === 0) return undefined;

    // Find lowest priority (highest number)
    let lowestPriorityJob = jobs[0];
    for (const job of jobs) {
      if (job.priority > lowestPriorityJob.priority) {
        lowestPriorityJob = job;
      }
    }

    return this.queue.removeById(lowestPriorityJob.id);
  }
}

