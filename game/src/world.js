// EMBERLINE — world.js
// Harbor Yard: an original 44 x 36 m dusk container yard with three lanes
// (North, Mid, South) and two bomb sites. The world is data first: a list of
// axis-aligned boxes for collision and cover, a waypoint graph bots route
// over with BFS, and pure geometry queries the sim and the renderer share.
// Coordinates: x east (+x toward the defenders), z south (+z toward Site B),
// y up. The yard spans x in [-22, 22], z in [-18, 18].

import { clamp, dist2d } from './util.js';

export const WORLD = {
  minX: -22, maxX: 22, minZ: -18, maxZ: 18,
  wallH: 4.2,
  roundTime: 100,      // seconds of live round after the buy phase
  buyTime: 14,         // seconds of buy phase at the start of each round
  plantTime: 3,        // seconds to plant the charge
  defuseTime: 5,        // seconds to defuse the charge
  fuseTime: 35,        // seconds from plant to detonation
  siteRadius: 4.2,
};

export const SITES = {
  A: { id: 'A', x: 15.5, z: -11.5, color: 0xffb020, label: 'SITE A' },
  B: { id: 'B', x: 15.5, z: 11.5, color: 0x27d3ff, label: 'SITE B' },
};

export const SPAWNS = {
  ember: [ // attackers, west side, facing east (+x)
    { x: -19.5, z: -5 }, { x: -19.5, z: -1.5 }, { x: -19.5, z: 1.5 },
    { x: -19.5, z: 5 }, { x: -18, z: 0 },
  ],
  vanguard: [ // defenders, east side, facing west (-x)
    { x: 19.5, z: -5 }, { x: 19.5, z: -1.5 }, { x: 19.5, z: 1.5 },
    { x: 19.5, z: 5 }, { x: 18, z: 0 },
  ],
};

// Obstacles: {x0,z0,x1,z1,h,color,kind}. kind 'box' blocks sight above 1.3 m
// and always blocks movement; 'crate' (h <= 1.2) blocks movement only.
export const OBSTACLES = [
  // North lane cover
  { x0: -9, z0: -16.2, x1: -3, z1: -13.2, h: 2.6, color: 0xb34a2e, kind: 'box' },
  { x0: 5, z0: -16.4, x1: 11, z1: -13.4, h: 2.6, color: 0x2e6f8e, kind: 'box' },
  // Mid lane cover
  { x0: -11, z0: -2.2, x1: -5, z1: 0.8, h: 2.6, color: 0xc78a2c, kind: 'box' },
  { x0: 7, z0: -1.6, x1: 13, z1: 1.4, h: 2.6, color: 0x4a6b4f, kind: 'box' },
  // South lane cover
  { x0: -9, z0: 13.2, x1: -3, z1: 16.2, h: 2.6, color: 0x2e6f8e, kind: 'box' },
  { x0: 5, z0: 13.4, x1: 11, z1: 16.4, h: 2.6, color: 0xb34a2e, kind: 'box' },
  // Central stack: two containers, one riding on the other
  { x0: -2.5, z0: -4.5, x1: 3.5, z1: -1.5, h: 2.6, color: 0x8e3b4d, kind: 'box' },
  { x0: -1.5, z0: -4.0, x1: 2.5, z1: -2.0, h: 5.2, color: 0x6b4a8e, kind: 'box' },
  // Tall stack, west mid — the yard's landmark
  { x0: -16.5, z0: -11, x1: -13.5, z1: -8, h: 5.2, color: 0xc78a2c, kind: 'box' },
  // Site A cover
  { x0: 16.5, z0: -15, x1: 20, z1: -11, h: 2.6, color: 0x4a6b4f, kind: 'box' },
  { x0: 11.5, z0: -9.5, x1: 13.5, z1: -7.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  // Site B cover
  { x0: 16.5, z0: 11, x1: 20, z1: 15, h: 2.6, color: 0x2e6f8e, kind: 'box' },
  { x0: 11.5, z0: 7.5, x1: 13.5, z1: 9.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  // Spawn cover, both ends
  { x0: -20, z0: -5.5, x1: -18, z1: -3.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: -20, z0: 3.5, x1: -18, z1: 5.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: 18, z0: -5.5, x1: 20, z1: -3.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: 18, z0: 3.5, x1: 20, z1: 5.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  // Scattered low crates for mid-lane fights
  { x0: -14.5, z0: -6.5, x1: -12.5, z1: -4.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: -14.5, z0: 4.5, x1: -12.5, z1: 6.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: 1.5, z0: -8.5, x1: 3.5, z1: -6.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
  { x0: 1.5, z0: 6.5, x1: 3.5, z1: 8.5, h: 1.1, color: 0x7a6a55, kind: 'crate' },
];

// Waypoint graph. Bots walk node to node; edges link neighbours the map
// actually connects. Node ids are stable so BFS paths are reproducible.
export const WAYPOINTS = [
  { id: 0, x: -19, z: 0 },    // ember spawn
  { id: 1, x: -14, z: 0 },    // west mid
  { id: 2, x: -8, z: 0 },     // west cross
  { id: 3, x: 0, z: 0 },      // yard centre
  { id: 4, x: 8, z: 0 },      // east cross
  { id: 5, x: 14, z: 0 },     // east mid
  { id: 6, x: 19, z: 0 },     // vanguard spawn
  { id: 7, x: -14, z: -12 },  // north west
  { id: 8, x: -6, z: -13 },   // north lane
  { id: 9, x: 2, z: -12 },    // north mid
  { id: 10, x: 10, z: -12 },  // north east
  { id: 11, x: 15.5, z: -11.5 }, // site A
  { id: 12, x: -14, z: 12 },  // south west
  { id: 13, x: -6, z: 13 },   // south lane
  { id: 14, x: 2, z: 12 },    // south mid
  { id: 15, x: 10, z: 12 },   // south east
  { id: 16, x: 15.5, z: 11.5 }, // site B
  { id: 17, x: -8, z: -6 },   // north cut
  { id: 18, x: -8, z: 6 },    // south cut
  { id: 19, x: 8, z: -6 },    // north cut east
  { id: 20, x: 8, z: 6 },     // south cut east
];

const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6],
  [0, 7], [7, 8], [8, 9], [9, 10], [10, 11],
  [0, 12], [12, 13], [13, 14], [14, 15], [15, 16],
  [2, 17], [17, 8], [2, 18], [18, 13],
  [3, 17], [3, 18], [3, 19], [3, 20],
  [4, 19], [19, 10], [4, 20], [20, 15],
  [1, 7], [1, 12], [5, 10], [5, 15],
  [9, 19], [14, 20], [11, 10], [16, 15],
];

const ADJ = WAYPOINTS.map(() => []);
for (const [a, b] of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

/** BFS shortest path of waypoint ids from `from` to `to` (inclusive). */
export function bfsPath(from, to) {
  if (from === to) return [from];
  const prev = new Array(WAYPOINTS.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of ADJ[cur]) {
      if (prev[nxt] !== -1) continue;
      prev[nxt] = cur;
      if (nxt === to) {
        const path = [to];
        let n = to;
        while (n !== from) { n = prev[n]; path.unshift(n); }
        return path;
      }
      queue.push(nxt);
    }
  }
  return [from];
}

/** Nearest waypoint id to a point. */
export function nearestWaypoint(x, z) {
  let best = 0, bd = Infinity;
  for (const w of WAYPOINTS) {
    const d = dist2d(x, z, w.x, w.z);
    if (d < bd) { bd = d; best = w.id; }
  }
  return best;
}

/** Is (x, z) inside an obstacle (movement collision)? */
export function insideObstacle(x, z) {
  for (const o of OBSTACLES) {
    if (x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return o;
  }
  return null;
}

/**
 * Move a circle (radius r) from (x, z) by (dx, dz), sliding along AABBs and
 * the yard walls. Returns the new [x, z]. Pure and allocation-light.
 */
export function moveCircle(x, z, dx, dz, r) {
  let nx = clamp(x + dx, WORLD.minX + r, WORLD.maxX - r);
  let nz = clamp(z + dz, WORLD.minZ + r, WORLD.maxZ - r);
  for (const o of OBSTACLES) {
    // Resolve X first, then Z, so the circle slides along faces.
    if (nz > o.z0 - r && nz < o.z1 + r && nx > o.x0 - r && nx < o.x1 + r) {
      const pushL = (nx + r) - o.x0, pushR = o.x1 - (nx - r);
      nx = pushL < pushR ? o.x0 - r : o.x1 + r;
    }
    if (nx > o.x0 - r && nx < o.x1 + r && nz > o.z0 - r && nz < o.z1 + r) {
      const pushU = (nz + r) - o.z0, pushD = o.z1 - (nz - r);
      nz = pushU < pushD ? o.z0 - r : o.z1 + r;
    }
  }
  return [nx, nz];
}

// Segment (2D) vs AABB test, slab method. Returns true when the segment
// crosses the box (touching counts as crossing: cover is cover).
function segHitsBox(ax, az, bx, bz, o) {
  const dx = bx - ax, dz = bz - az;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ax < o.x0 || ax > o.x1) return false;
  } else {
    let t1 = (o.x0 - ax) / dx, t2 = (o.x1 - ax) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < o.z0 || az > o.z1) return false;
  } else {
    let t1 = (o.z0 - az) / dz, t2 = (o.z1 - az) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/**
 * Line of sight between two points at eye height: blocked by any box taller
 * than 1.3 m (crates are low cover, containers block). Returns true when the
 * line is clear.
 */
export function hasLineOfSight(ax, az, bx, bz) {
  for (const o of OBSTACLES) {
    if (o.h <= 1.3) continue;
    if (segHitsBox(ax, az, bx, bz, o)) return false;
  }
  return true;
}

/**
 * Nearest obstacle a ray from (ox, oy, oz) along dir hits, within maxDist.
 * Only boxes taller than the ray's height block it. Returns {t, obstacle} or
 * null. Used for bullet impact points.
 */
export function rayHitObstacle(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = null;
  for (const o of OBSTACLES) {
    if (oy > o.h && dy >= 0) continue; // ray starts above the box, rising
    // 3D slab test against the box.
    let tmin = 0, tmax = maxDist;
    const axes = [[ox, dx, o.x0, o.x1], [oy, dy, 0, o.h], [oz, dz, o.z0, o.z1]];
    let ok = true;
    for (const [p, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (p < lo || p > hi) { ok = false; break; }
      } else {
        let t1 = (lo - p) / d, t2 = (hi - p) / d;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok && (best === null || tmin < best.t)) best = { t: tmin, obstacle: o };
  }
  return best;
}

/** Which site (if any) contains the point, or null. */
export function siteAt(x, z) {
  for (const s of Object.values(SITES)) {
    if (dist2d(x, z, s.x, s.z) <= WORLD.siteRadius) return s;
  }
  return null;
}

/** A random point inside a site, clear of obstacles (for bot plant spots). */
export function randomSitePoint(site, rng) {
  for (let tries = 0; tries < 12; tries++) {
    const a = rng() * Math.PI * 2, r = rng() * (WORLD.siteRadius - 1);
    const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r;
    if (!insideObstacle(x, z)) return { x, z };
  }
  return { x: site.x, z: site.z };
}
