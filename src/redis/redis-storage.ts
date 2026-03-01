import type { Redis, RedisOptions, Cluster, ClusterOptions } from 'ioredis';
import {
  ACQUIRE_SLOT,
  RELEASE_SLOT,
  GET_STATE,
  UPDATE_RESERVOIR,
  INCREMENT_RESERVOIR,
  INIT_STATE,
  CLEAR_STATE,
  HEARTBEAT,
} from './lua-scripts.js';

/**
 * Result of acquiring a slot
 */
export interface AcquireResult {
  allowed: boolean;
  running: number;
  waitTime: number;
  reason: 'ok' | 'concurrency' | 'reservoir' | 'interval' | 'minTime';
}

/**
 * Distributed state from Redis
 */
export interface DistributedState {
  running: number;
  currentWeight: number;
  done: number;
  failed: number;
  reservoir: number | null;
}

/**
 * Redis connection options
 */
export interface RedisConnectionOptions {
  /** Redis connection URL (redis://...) */
  url?: string;
  /** Redis host */
  host?: string;
  /** Redis port */
  port?: number;
  /** Redis password */
  password?: string;
  /** Redis database number */
  db?: number;
  /** Key prefix for this limiter */
  keyPrefix?: string;
  /** Use Redis Cluster */
  cluster?: boolean;
  /** Cluster nodes */
  clusterNodes?: Array<{ host: string; port: number }>;
  /** Additional ioredis options */
  redisOptions?: RedisOptions;
  /** Cluster options */
  clusterOptions?: ClusterOptions;
  /** Existing Redis client to use */
  client?: Redis | Cluster;
}

/**
 * Script definition with source and SHA
 */
interface ScriptDef {
  source: string;
  sha?: string;
}

/**
 * Redis storage adapter for distributed rate limiting
 */
export class RedisStorage {
  private client: Redis | Cluster;
  private readonly keyPrefix: string;
  private readonly ownClient: boolean;
  private initialized = false;

  // Scripts with their source and cached SHAs
  private scripts: Map<string, ScriptDef> = new Map([
    ['acquire', { source: ACQUIRE_SLOT }],
    ['release', { source: RELEASE_SLOT }],
    ['getState', { source: GET_STATE }],
    ['updateReservoir', { source: UPDATE_RESERVOIR }],
    ['incrementReservoir', { source: INCREMENT_RESERVOIR }],
    ['initState', { source: INIT_STATE }],
    ['clearState', { source: CLEAR_STATE }],
    ['heartbeat', { source: HEARTBEAT }],
  ]);

  constructor(options: RedisConnectionOptions) {
    this.keyPrefix = options.keyPrefix ?? 'ratelimit';
    this.ownClient = !options.client;

    if (options.client) {
      this.client = options.client;
    } else {
      // Dynamically import ioredis
      this.client = this.createClient(options);
    }
  }

  private createClient(options: RedisConnectionOptions): Redis | Cluster {
    // Dynamic import to make Redis optional
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require('ioredis');

    if (options.cluster && options.clusterNodes) {
      return new IORedis.Cluster(options.clusterNodes, {
        redisOptions: {
          password: options.password,
          ...options.redisOptions,
        },
        ...options.clusterOptions,
      });
    }

    if (options.url) {
      return new IORedis.default(options.url, options.redisOptions);
    }

    return new IORedis.default({
      host: options.host ?? 'localhost',
      port: options.port ?? 6379,
      password: options.password,
      db: options.db ?? 0,
      ...options.redisOptions,
    });
  }

  /**
   * Execute a Lua script with automatic fallback to EVAL if EVALSHA fails
   */
  private async execScript(
    name: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    const script = this.scripts.get(name);
    if (!script) {
      throw new Error(`Unknown script: ${name}`);
    }

    // Try EVALSHA first if we have a cached SHA
    if (script.sha) {
      try {
        return await this.client.evalsha(script.sha, numKeys, ...args);
      } catch (error) {
        // If NOSCRIPT error, fall through to EVAL
        if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) {
          throw error;
        }
        // Clear the cached SHA
        script.sha = undefined;
      }
    }

    // Use EVAL and cache the SHA for next time
    const result = await this.client.eval(script.source, numKeys, ...args);

    // Cache SHA for future calls (load script)
    try {
      script.sha = await this.client.script('LOAD', script.source) as string;
    } catch {
      // Ignore errors loading script - we'll just use EVAL next time
    }

    return result;
  }

  /**
   * Initialize storage and load Lua scripts
   */
  async initialize(limiterId: string, reservoir: number | null): Promise<void> {
    if (this.initialized) return;

    // Pre-load all scripts
    for (const [name, script] of this.scripts) {
      try {
        script.sha = await this.client.script('LOAD', script.source) as string;
      } catch {
        // Ignore - we'll use EVAL as fallback
      }
    }

    // Initialize state
    const key = this.getKey(limiterId);
    await this.execScript('initState', 1, key, reservoir ?? -1);

    this.initialized = true;
  }

  /**
   * Get the Redis key for a limiter
   */
  private getKey(limiterId: string): string {
    return `${this.keyPrefix}:${limiterId}`;
  }

  /**
   * Try to acquire a slot for job execution
   */
  async acquireSlot(
    limiterId: string,
    options: {
      maxConcurrent: number;
      minTime: number;
      maxPerInterval: number;
      interval: number;
      weight: number;
      jobId: string;
    }
  ): Promise<AcquireResult> {
    const key = this.getKey(limiterId);
    const now = Date.now();

    const result = await this.execScript(
      'acquire',
      1,
      key,
      options.maxConcurrent,
      options.minTime,
      options.maxPerInterval,
      options.interval,
      now,
      options.weight,
      options.jobId
    ) as [number, number, number, string];

    return {
      allowed: result[0] === 1,
      running: result[1],
      waitTime: result[2],
      reason: result[3] as AcquireResult['reason'],
    };
  }

  /**
   * Release a slot after job completion
   */
  async releaseSlot(
    limiterId: string,
    jobId: string,
    weight: number,
    success: boolean
  ): Promise<number> {
    const key = this.getKey(limiterId);

    return await this.execScript(
      'release',
      1,
      key,
      weight,
      jobId,
      success ? 1 : 0
    ) as number;
  }

  /**
   * Get current distributed state
   */
  async getState(limiterId: string): Promise<DistributedState> {
    const key = this.getKey(limiterId);

    const result = await this.execScript(
      'getState',
      1,
      key
    ) as [number, number, number, number, number];

    return {
      running: result[0],
      currentWeight: result[1],
      done: result[2],
      failed: result[3],
      reservoir: result[4] === -1 ? null : result[4],
    };
  }

  /**
   * Update reservoir value
   */
  async updateReservoir(limiterId: string, value: number): Promise<number> {
    const key = this.getKey(limiterId);

    return await this.execScript(
      'updateReservoir',
      1,
      key,
      value
    ) as number;
  }

  /**
   * Increment reservoir value
   */
  async incrementReservoir(limiterId: string, amount: number): Promise<number> {
    const key = this.getKey(limiterId);

    return await this.execScript(
      'incrementReservoir',
      1,
      key,
      amount
    ) as number;
  }

  /**
   * Clear all state for a limiter
   */
  async clear(limiterId: string): Promise<void> {
    const key = this.getKey(limiterId);

    await this.execScript(
      'clearState',
      1,
      key
    );
  }

  /**
   * Send heartbeat to keep state alive
   */
  async heartbeat(limiterId: string, timeout: number): Promise<number> {
    const key = this.getKey(limiterId);
    const now = Date.now();

    return await this.execScript(
      'heartbeat',
      1,
      key,
      now,
      timeout
    ) as number;
  }

  /**
   * Subscribe to reservoir depletion events
   */
  async subscribeToEvents(
    limiterId: string,
    callback: (event: string, data: unknown) => void
  ): Promise<() => void> {
    const channel = `${this.keyPrefix}:${limiterId}:events`;
    
    // Create a subscriber connection
    const subscriber = this.client.duplicate();
    
    await subscriber.subscribe(channel);
    
    subscriber.on('message', (ch, message) => {
      if (ch === channel) {
        try {
          const { event, data } = JSON.parse(message);
          callback(event, data);
        } catch {
          // Ignore parse errors
        }
      }
    });

    return () => {
      subscriber.unsubscribe(channel);
      subscriber.quit();
    };
  }

  /**
   * Publish an event
   */
  async publishEvent(limiterId: string, event: string, data: unknown): Promise<void> {
    const channel = `${this.keyPrefix}:${limiterId}:events`;
    await this.client.publish(channel, JSON.stringify({ event, data }));
  }

  /**
   * Get the underlying Redis client
   */
  getClient(): Redis | Cluster {
    return this.client;
  }

  /**
   * Check if connected to Redis
   */
  isConnected(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * Wait for Redis connection.
   * @param timeout - Max wait in ms. Use `Infinity` or `null` to wait until connected (no timeout).
   * @default 5000
   */
  async waitForConnection(timeout: number | null = 5000): Promise<void> {
    if (this.isConnected()) return;

    // If client is already in a terminal failure state, reject immediately
    const status = this.client.status;
    if (status === 'end' || status === 'close') {
      return Promise.reject(new Error(`Redis connection already closed (status: ${status})`));
    }

    const useTimeout = timeout != null && Number.isFinite(timeout) && timeout > 0;

    return new Promise((resolve, reject) => {
      const timer = useTimeout
        ? setTimeout(() => {
            reject(new Error('Redis connection timeout'));
          }, timeout)
        : undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
      };

      this.client.once('ready', () => {
        cleanup();
        resolve();
      });

      this.client.once('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    if (this.ownClient) {
      await this.client.quit();
    }
  }
}

