# @taukirsheikh/rate-limiter

Control how many tasks run at once and how fast they start. Use it when you're calling an API that has rate limits, or when you want to avoid overloading a service.

**In production** Node usually runs on **multiple instances** (containers, PM2 cluster, several servers). Each process has its own memory, so you need a **Redis-backed limiter** to share one limit across all of them. Use `DistributedRateLimiter` for that.

**Install**

```bash
npm install @taukirsheikh/rate-limiter
```

**Production (multiple instances) — use Redis**

```javascript
import { DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

const limiter = new DistributedRateLimiter({
  maxConcurrent: 10,
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
});
await limiter.ready();

const result = await limiter.schedule(() => fetch('https://api.example.com/data'));
```

All instances share the same queue and limits.

**Single process (dev or one instance)** — in-memory

```javascript
import { RateLimiter } from '@taukirsheikh/rate-limiter';

const limiter = new RateLimiter({
  maxConcurrent: 2,
  minTime: 500,
});
const result = await limiter.schedule(() => fetch('https://api.example.com/data'));
```

**Sample: API function + limiter.schedule**

Define an async function that calls your API, then run it through the limiter so it’s rate-limited:

```javascript
import { DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

// Your API-calling function
async function fetchUser(id) {
  const res = await fetch(`https://api.example.com/users/${id}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

const limiter = new DistributedRateLimiter({
  maxConcurrent: 5,
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
});
await limiter.ready();

// Run the function through the limiter — same args, same return
const user = await limiter.schedule(() => fetchUser(1));
```

`schedule` returns whatever your function returns, so you can destructure:

```javascript
// With axios
const { data } = await limiter.schedule(async () => axios.request(config));

// Or wrap once and call many times
const limitedFetchUser = limiter.wrap(fetchUser);
const user1 = await limitedFetchUser(1);
const user2 = await limitedFetchUser(2);
```

**What you can do**

- Limit concurrency (e.g. max 5 at a time).
- Space out jobs (e.g. at least 100ms between starts).
- Cap jobs per minute/hour with `maxPerInterval` and `interval`.
- Use a token bucket with `reservoir` and refill options.
- Give jobs priority so important work runs first.
- Wrap any async function with `limiter.wrap(fn)`.
- Retry failed jobs with `retryCount` and `retryDelay`.
- Cancel with `limiter.cancel(jobId)` or an `AbortSignal`.

**Docs**

Full guides and API reference: **[docs.page/taukirsheikh/rate-limiter](https://docs.page/taukirsheikh/rate-limiter)**

**Try the examples**

```bash
npm run example        # in-memory limiter
npm run example:redis  # Redis (needs Redis running)
```

**License** — MIT
