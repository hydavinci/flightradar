/**
 * Enhanced flight cache with deduplication, history tracking
 */

class FlightCache {
  constructor() {
    this.aircraft = new Map(); // icao24 -> aircraft data
    this.history = new Map();  // icao24 -> [{lat, lon, alt, ts}, ...] (last N positions)
    this.lastUpdate = 0;
    this.maxHistory = 60;      // positions per aircraft
  }

  /**
   * Merge new flights with existing data (multi-source dedup)
   * Priority: FR24 > adsb.fi > adsb.lol (FR24 has route info)
   */
  update(flights) {
    const now = Date.now();

    for (const f of flights) {
      if (!f.icao24 || !f.lat || !f.lon) continue;

      const existing = this.aircraft.get(f.icao24);

      if (existing) {
        // Merge: prefer newer position, richer metadata
        const merged = { ...existing };

        // Always update position to newest
        if (!f.seen || f.seen < (existing.seen || 999)) {
          merged.lat = f.lat;
          merged.lon = f.lon;
          merged.altitude = f.altitude ?? existing.altitude;
          merged.heading = f.heading ?? existing.heading;
          merged.velocity = f.velocity ?? existing.velocity;
          merged.verticalRate = f.verticalRate ?? existing.verticalRate;
          merged.onGround = f.onGround ?? existing.onGround;
          merged.seen = f.seen;
        }

        // Fill in missing metadata from richer source
        if (f.callsign && !merged.callsign) merged.callsign = f.callsign;
        if (f.registration && !merged.registration) merged.registration = f.registration;
        if (f.type && !merged.type) merged.type = f.type;
        if (f.origin && !merged.origin) merged.origin = f.origin;
        if (f.destination && !merged.destination) merged.destination = f.destination;
        if (f.airline && !merged.airline) merged.airline = f.airline;
        if (f.squawk && !merged.squawk) merged.squawk = f.squawk;
        if (f.country && !merged.country) merged.country = f.country;

        // Track source priority (fr24 > fi > lol)
        const priority = { fr24: 3, fi: 2, lol: 1 };
        if ((priority[f._source] || 0) > (priority[merged._source] || 0)) {
          merged._source = f._source;
          // FR24 has better route data, prefer it
          if (f.origin) merged.origin = f.origin;
          if (f.destination) merged.destination = f.destination;
          if (f.airline) merged.airline = f.airline;
          if (f.callsign) merged.callsign = f.callsign;
        }

        merged._updated = now;
        this.aircraft.set(f.icao24, merged);
      } else {
        this.aircraft.set(f.icao24, { ...f, _updated: now });
      }

      // Record history for trail
      this._recordHistory(f.icao24, f.lat, f.lon, f.altitude, now);
    }

    this.lastUpdate = now;
  }

  startPruneInterval() {
    setInterval(() => this.prune(90000), 30000);
  }

  _recordHistory(icao24, lat, lon, alt, ts) {
    if (!this.history.has(icao24)) {
      this.history.set(icao24, []);
    }
    const trail = this.history.get(icao24);
    const last = trail[trail.length - 1];
    
    // Only record if position changed
    if (!last || Math.abs(last.lat - lat) > 0.001 || Math.abs(last.lon - lon) > 0.001) {
      trail.push({ lat, lon, alt, ts });
      if (trail.length > this.maxHistory) trail.shift();
    }
  }

  prune(maxAge = 90000) {
    const cutoff = Date.now() - maxAge;
    for (const [icao, data] of this.aircraft) {
      if (data._updated < cutoff) {
        this.aircraft.delete(icao);
        this.history.delete(icao);
      }
    }
  }

  getAll() {
    const aircraft = [];
    for (const [, data] of this.aircraft) {
      const { _updated, _source, _fr24Id, ...rest } = data;
      aircraft.push(rest);
    }
    return {
      aircraft,
      timestamp: this.lastUpdate,
      count: aircraft.length
    };
  }

  getTrail(icao24) {
    return this.history.get(icao24) || [];
  }

  getStats() {
    let bySource = { lol: 0, fi: 0, fr24: 0, unknown: 0 };
    for (const [, data] of this.aircraft) {
      bySource[data._source || 'unknown']++;
    }
    return {
      total: this.aircraft.size,
      bySource,
      lastUpdate: this.lastUpdate
    };
  }
}

const cache = new FlightCache();
cache.startPruneInterval();
export default cache;
