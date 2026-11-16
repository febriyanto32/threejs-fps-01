// EMBERLINE — weapons.js
// The armoury: five original weapons plus a frag grenade. Every weapon is
// one data row; the fire model (recoil, spread, damage falloff, headshots)
// is shared code, so a weapon's feel comes from its numbers, not a special
// case. Headshots deal x4 damage: stopping to aim pays.

import { clamp } from './util.js';
import { rayHitObstacle } from './world.js';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 Sidearm', short: 'P9', price: 0, damage: 26, headMult: 4,
    mag: 12, reserve: Infinity, rpm: 380, auto: false, pellets: 1,
    spreadDeg: 0.55, moveSpread: 1.7, recoil: 0.55, heatPerShot: 0.10,
    range: 60, reloadS: 1.05, zoom: 1, kick: 0.35, tracer: 0xffe08a,
  },
  vk47: {
    id: 'vk47', name: 'VK-47 Long Rifle', short: 'VK-47', price: 2700, damage: 33, headMult: 4,
    mag: 30, reserve: 120, rpm: 600, auto: true, pellets: 1,
    spreadDeg: 0.8, moveSpread: 2.3, recoil: 0.95, heatPerShot: 0.13,
    range: 95, reloadS: 2.2, zoom: 1.25, kick: 0.6, tracer: 0xffc46b,
  },
  kestrel: {
    id: 'kestrel', name: 'Kestrel-9 SMG', short: 'Kestrel-9', price: 1500, damage: 22, headMult: 4,
    mag: 32, reserve: 128, rpm: 820, auto: true, pellets: 1,
    spreadDeg: 1.0, moveSpread: 1.9, recoil: 0.6, heatPerShot: 0.11,
    range: 45, reloadS: 1.9, zoom: 1, kick: 0.45, tracer: 0x9be8ff,
  },
  longbow: {
    id: 'longbow', name: 'Longbow .50 Marksman', short: 'Longbow .50', price: 4750, damage: 95, headMult: 4,
    mag: 5, reserve: 20, rpm: 55, auto: false, pellets: 1,
    spreadDeg: 0.12, moveSpread: 3.2, recoil: 3.4, heatPerShot: 0.55,
    range: 130, reloadS: 3.2, zoom: 4, kick: 1.9, tracer: 0xffffff,
  },
  breacher: {
    id: 'breacher', name: 'Breacher-12 Scattergun', short: 'Breacher-12', price: 1700, damage: 11, headMult: 4,
    mag: 6, reserve: 24, rpm: 75, auto: false, pellets: 8,
    spreadDeg: 2.6, moveSpread: 2.1, recoil: 1.7, heatPerShot: 0.5,
    range: 24, reloadS: 2.8, zoom: 1, kick: 1.25, tracer: 0xffa04d,
  },
};

export const GRENADE = {
  id: 'grenade', name: 'Spark Frag', price: 300, damage: 120, radius: 6.5,
  fuseS: 2.4, throwSpeed: 13, gravity: 12,
};

export const BUY_ORDER = ['p9', 'kestrel', 'breacher', 'vk47', 'longbow'];

/** Fresh weapon state for an agent holding `weaponId`. */
export function freshWeaponState(weaponId) {
  const w = WEAPONS[weaponId];
  return {
    weaponId, mag: w.mag, reserve: w.reserve, reloading: false, reloadT: 0,
    heat: 0, recoilPitch: 0, recoilYaw: 0, cooldown: 0, grenades: 1,
  };
}

/** Current spread in degrees: still and cold is tight, moving and hot is wild. */
export function currentSpreadDeg(w, speed, airborne, crouched) {
  let s = w.spreadDeg;
  if (speed > 0.5) s += w.moveSpread * Math.min(1, speed / 4.2);
  if (airborne) s += 2.2;
  if (crouched) s *= 0.7;
  return s;
}

/**
 * Damage at a distance: full up to 60% of range, then linear falloff to 55%
 * at max range. Headshots multiply by headMult (x4).
 */
export function damageAt(w, dist, headshot) {
  const fall = dist > w.range * 0.6
    ? 1 - 0.45 * ((dist - w.range * 0.6) / (w.range * 0.4))
    : 1;
  return Math.round(w.damage * Math.max(0.55, fall) * (headshot ? w.headMult : 1));
}

// --- Hit testing -----------------------------------------------------------
// A body is a vertical capsule: torso cylinder (radius 0.42, y 0.55..1.45)
// plus a head sphere (radius 0.27, centre y 1.66). A ray that hits the head
// sphere is a headshot; the torso is a body hit. Walls win when nearer.

/** Ray vs a vertical capsule. Returns {t, head} or null. */
function rayHitBody(ox, oy, oz, dx, dy, dz, cx, cz, maxT) {
  // Head sphere first (small, high value).
  const hx = cx - ox, hy = 1.66 - oy, hz = cz - oz;
  const b = hx * dx + hy * dy + hz * dz;
  const c = hx * hx + hy * hy + hz * hz - 0.27 * 0.27;
  const disc = b * b - c;
  if (disc > 0) {
    const t = b - Math.sqrt(disc);
    if (t > 0 && t < maxT) return { t, head: true };
  }
  // Torso: 2D circle in XZ, then check the hit height.
  const ex = cx - ox, ez = cz - oz;
  const bb = ex * dx + ez * dz;
  const cc = ex * ex + ez * ez - 0.42 * 0.42;
  const dd = bb * bb - cc;
  if (dd <= 0) return null;
  const t = bb - Math.sqrt(dd);
  if (t <= 0 || t >= maxT) return null;
  const y = oy + dy * t;
  if (y < 0.45 || y > 1.5) return null;
  return { t, head: false };
}

/**
 * Fire one trigger pull from (ox,oy,oz) along (dx,dy,dz) with the shooter's
 * current spread. `targets` are agents with {x, z, alive, id}. Returns the
 * pellet results: [{target, head, dist, point}] plus the wall impact point
 * for tracers and sparks. `rng` supplies the spread jitter.
 */
export function fireShot(ox, oy, oz, dx, dy, dz, weapon, spreadDeg, targets, rng) {
  const results = [];
  const spreadRad = (spreadDeg * Math.PI) / 180;
  for (let p = 0; p < weapon.pellets; p++) {
    // Jitter the direction inside a cone of the current spread.
    const a = rng() * Math.PI * 2, r = rng() * spreadRad;
    const jx = Math.cos(a) * r, jy = Math.sin(a) * r;
    // Build an orthonormal basis around the direction.
    const ux = -dz, uz = dx, ul = Math.hypot(ux, uz) || 1;
    const rx = ux / ul, rz = uz / ul;
    const ryx = dz * rz, ryy = 0, ryz = -dx * rz;
    const px = dx + rx * jx + ryx * jy;
    const py = dy + ryy * jy;
    const pz = dz + rz * jx + ryz * jy;
    const pl = Math.hypot(px, py, pz);
    const ddx = px / pl, ddy = py / pl, ddz = pz / pl;

    const wall = rayHitObstacle(ox, oy, oz, ddx, ddy, ddz, weapon.range);
    let bestT = wall ? wall.t : weapon.range;
    let hit = null;
    for (const t of targets) {
      if (!t.alive) continue;
      const hb = rayHitBody(ox, oy, oz, ddx, ddy, ddz, t.x, t.z, bestT);
      if (hb && hb.t < bestT) { bestT = hb.t; hit = { target: t, head: hb.head }; }
    }
    if (hit) {
      results.push({
        target: hit.target, head: hit.head, dist: bestT,
        point: [ox + ddx * bestT, oy + ddy * bestT, oz + ddz * bestT],
      });
    } else {
      results.push({
        target: null, head: false, dist: bestT,
        point: [ox + ddx * bestT, oy + ddy * bestT, oz + ddz * bestT],
        wall: !!wall,
      });
    }
  }
  return results;
}

/** A grenade's arc: position after t seconds from a throw. */
export function grenadePos(from, dir, t) {
  const g = GRENADE.gravity;
  return [
    from[0] + dir[0] * GRENADE.throwSpeed * t,
    Math.max(0.12, from[1] + dir[1] * GRENADE.throwSpeed * t - 0.5 * g * t * t),
    from[2] + dir[2] * GRENADE.throwSpeed * t,
  ];
}

/** Grenade damage at a distance from the blast (linear falloff, min 15). */
export function grenadeDamageAt(dist) {
  if (dist > GRENADE.radius) return 0;
  return Math.round(clamp(GRENADE.damage * (1 - dist / GRENADE.radius), 15, GRENADE.damage));
}
