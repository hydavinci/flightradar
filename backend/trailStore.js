/**
 * Redis-backed trail storage
 * Stores last N positions per aircraft, persists across restarts
 */
import Redis from 'ioredis';

const redis = new Redis({ maxRetriesPerRequest: 3 });
const TRAIL_PREFIX = 'trail:';
const MAX_TRAIL_POINTS = 120; // ~20 min at 10s intervals
const TRAIL_TTL = 3600; // expire trails after 1 hour of no updates

class TrailStore {
  /**
   * Append a position to an aircraft's trail
   */
  async append(icao24, lat, lon, alt, ts) {
    const key = TRAIL_PREFIX + icao24;
    const point = JSON.stringify({ lat, lon, alt, ts });

    const pipeline = redis.pipeline();
    pipeline.rpush(key, point);
    pipeline.ltrim(key, -MAX_TRAIL_POINTS, -1); // keep last N
    pipeline.expire(key, TRAIL_TTL);
    await pipeline.exec();
  }

  /**
   * Append multiple aircraft positions in batch
   */
  async appendBatch(updates) {
    if (updates.length === 0) return;
    const pipeline = redis.pipeline();
    for (const { icao24, lat, lon, alt, ts } of updates) {
      const key = TRAIL_PREFIX + icao24;
      const point = JSON.stringify({ lat, lon, alt, ts });
      pipeline.rpush(key, point);
      pipeline.ltrim(key, -MAX_TRAIL_POINTS, -1);
      pipeline.expire(key, TRAIL_TTL);
    }
    await pipeline.exec();
  }

  /**
   * Get trail for an aircraft
   */
  async getTrail(icao24) {
    const key = TRAIL_PREFIX + icao24;
    const raw = await redis.lrange(key, 0, -1);
    return raw.map(r => JSON.parse(r));
  }

  /**
   * Check if Redis is connected
   */
  async isHealthy() {
    try {
      const result = await redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}

export default new TrailStore();
