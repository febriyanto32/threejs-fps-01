// EMBERLINE — bots.js
// Bot brains: one controller per bot. A bot thinks in intents — where to
// walk, where to look, whether to fire — and the game loop executes them
// through the same movement and shooting code the player uses, so bots and
// the player play by the same rules. Routing is BFS over the world's
// waypoint graph; fighting is line-of-sight plus reaction time, aim error
// and burst fire; the objective is real: the carrier walks to a site and
// plants, defenders rotate to defuse, and a dropped charge gets picked up.

import { clamp, dist2d, angleDiff, angleToward, shuffled } from './util.js';
import { WAYPOINTS, bfsPath, nearestWaypoint, hasLineOfSight, siteAt, randomSitePoint } from './world.js';
import { SITES } from './world.js';

const THINK_EVERY = 0.15;   // seconds between decisions
const SEE_DIST = 55;        // how far a bot can spot an enemy
const HEAR_DIST = 20;       // gunfire heard inside this radius
const FOV = 1.9;            // radians of vision cone (~109 deg)

/** Skill spread: rookies react slow and miss wide, veterans do not. */
function skillFor(rng) {
  return {
    reaction: 0.35 + rng() * 0.4,   // seconds to open fire after spotting
    aimErrDeg: 2.2 + rng() * 3.0,   // degrees of aim error
    burst: 3 + Math.floor(rng() * 4),
    pause: 0.35 + rng() * 0.5,      // seconds between bursts
    aggression: 0.3 + rng() * 0.7,  // 0 = holds, 1 = pushes
  };
}

export function createBot(agent, rng) {
  return {
    agent,
    rng,
    skill: skillFor(rng),
    state: 'move',          // move | hold | engage | plant | defuse | pickup
    path: [], pathIdx: 0,
    dest: null,             // {x, z} final destination
    holdT: 0, holdYaw: agent.yaw,
    thinkT: rng() * THINK_EVERY,
    target: null,           // visible enemy agent
    seenT: 0,               // seconds the target has been visible
    burstLeft: 0, burstT: 0, pauseT: 0,
    strafeDir: 1, strafeT: 0,
    aimYaw: agent.yaw, aimPitch: 0,
    investigate: null,      // {x, z, t} a heard sound to check
    assignedSite: null,
    plantSpot: null,
  };
}

/** Assign round roles: ember bots pick a lane/site, vanguard bots hold. */
export function assignRoles(bots, match, rng) {
  const sites = shuffled(['A', 'B'], rng);
  let si = 0;
  for (const b of bots) {
    const a = b.agent;
    if (!a.alive) continue;
    b.plantSpot = null; // re-pick a fresh plant spot every round
    if (a.team === 'ember') {
      b.assignedSite = b.agent.id === match.charge.holderId
        ? sites[0]
        : sites[si++ % 2];
      b.state = 'move';
      b.dest = null;
      b.path = [];
    } else {
      // Defenders spread: two to each site, one mid.
      const spots = [11, 16, 3, 10, 15];
      const wp = WAYPOINTS[spots[Math.floor(rng() * spots.length)]];
      b.assignedSite = null;
      b.state = 'move';
      b.dest = { x: wp.x, z: wp.z };
      b.path = [];
    }
  }
}

/** Nearest visible enemy, or null. Hearing counts as a brief sighting. */
function spotEnemy(bot, agents) {
  const a = bot.agent;
  let best = null, bd = Infinity;
  for (const e of agents) {
    if (!e.alive || e.team === a.team) continue;
    const d = dist2d(a.x, a.z, e.x, e.z);
    if (d > SEE_DIST) continue;
    const yawTo = Math.atan2(e.x - a.x, -(e.z - a.z));
    const inCone = Math.abs(angleDiff(a.yaw, yawTo)) < FOV / 2;
    const heard = e.lastShotT !== undefined && (bot.now - e.lastShotT) < 0.5 && d < HEAR_DIST;
    if (!inCone && !heard) continue;
    if (!hasLineOfSight(a.x, a.z, e.x, e.z)) continue;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Set a BFS path from the bot's position to a waypoint id. */
function routeTo(bot, wpId) {
  const from = nearestWaypoint(bot.agent.x, bot.agent.z);
  bot.path = bfsPath(from, wpId);
  bot.pathIdx = 0;
}

/** Walk the current path; returns a move vector {mx, mz} or null at end. */
function followPath(bot, speed) {
  const a = bot.agent;
  while (bot.pathIdx < bot.path.length) {
    const wp = WAYPOINTS[bot.path[bot.pathIdx]];
    const d = dist2d(a.x, a.z, wp.x, wp.z);
    if (d < 0.7) { bot.pathIdx++; continue; }
    const mx = (wp.x - a.x) / d, mz = (wp.z - a.z) / d;
    return { mx, mz, speed, yaw: Math.atan2(mx, -mz) };
  }
  return null;
}

/** The bot's intent this tick: movement, aim, fire, and objective actions. */
export function updateBot(bot, ctx, dt) {
  const a = bot.agent;
  const intent = {
    mx: 0, mz: 0, speed: 0, yaw: a.yaw, pitch: 0,
    firing: false, reload: false, plant: false, defuse: false,
    grenade: false, crouch: false, jump: false,
  };
  if (!a.alive) return intent;
  bot.now = (bot.now || 0) + dt;
  bot.thinkT -= dt;

  // --- Perception, every think tick -------------------------------------
  if (bot.thinkT <= 0) {
    bot.thinkT = THINK_EVERY;
    const seen = spotEnemy(bot, ctx.agents);
    if (seen) {
      if (bot.target !== seen) { bot.seenT = 0; bot.target = seen; }
      bot.state = 'engage';
    } else if (bot.target) {
      bot.target = null;
      bot.seenT = 0;
      if (bot.state === 'engage') bot.state = 'move';
    }
    // Objective thinking (only when not fighting).
    if (!bot.target) decideObjective(bot, ctx);
    // Heard a shot nearby: turn to look, maybe investigate.
    if (ctx.lastShot && ctx.lastShot.shooter.team !== a.team) {
      const s = ctx.lastShot;
      const d = dist2d(a.x, a.z, s.x, s.z);
      if (d < HEAR_DIST && bot.state !== 'engage') {
        bot.investigate = { x: s.x, z: s.z, t: 2.5 };
        bot.holdYaw = Math.atan2(s.x - a.x, -(s.z - a.z));
      }
    }
  }

  // --- Engage: aim with error, burst fire, strafe -----------------------
  if (bot.target && bot.target.alive) {
    const t = bot.target;
    bot.seenT += dt;
    const d = dist2d(a.x, a.z, t.x, t.z);
    const aimY = 1.35 + (t.crouched ? -0.3 : 0) + (bot.rng() - 0.5) * 0.1;
    const yawTo = Math.atan2(t.x - a.x, -(t.z - a.z));
    const dy = aimY - 1.5;
    const pitchTo = Math.atan2(dy, d);
    const err = (bot.skill.aimErrDeg * Math.PI) / 180;
    bot.aimYaw = angleToward(bot.aimYaw, yawTo + (bot.rng() - 0.5) * err * 2, dt * 6);
    bot.aimPitch = clamp(pitchTo + (bot.rng() - 0.5) * err, -1.2, 1.2);
    intent.yaw = bot.aimYaw;
    intent.pitch = bot.aimPitch;
    // Strafe while fighting: sidestep, reverse on a timer or at cover.
    bot.strafeT -= dt;
    if (bot.strafeT <= 0) { bot.strafeDir *= -1; bot.strafeT = 0.7 + bot.rng() * 0.9; }
    const sx = Math.cos(yawTo) * bot.strafeDir, sz = -Math.sin(yawTo) * bot.strafeDir;
    const closing = d > 14 && bot.skill.aggression > 0.5;
    intent.mx = sx * 0.8 + (closing ? Math.sin(yawTo) * 0.6 : 0);
    intent.mz = sz * 0.8 + (closing ? -Math.cos(yawTo) * 0.6 : 0);
    intent.speed = 2.6;
    intent.crouch = d > 20 && bot.rng() < 0.3;
    // Burst fire once the reaction time has passed.
    if (bot.seenT > bot.skill.reaction) {
      if (bot.burstLeft <= 0) {
        bot.pauseT -= dt;
        if (bot.pauseT <= 0) { bot.burstLeft = bot.skill.burst; bot.pauseT = bot.skill.pause; }
      }
      if (bot.burstLeft > 0) {
        // The loop fires the shot and decrements burstLeft per shot fired.
        intent.firing = true;
      }
    }
    return intent;
  }

  // --- Plant / defuse channels ------------------------------------------
  if (bot.state === 'plant' && bot.plantSpot) {
    const d = dist2d(a.x, a.z, bot.plantSpot.x, bot.plantSpot.z);
    if (d > 1.2) {
      const mv = followPathTo(bot, bot.plantSpot);
      if (mv) { intent.mx = mv.mx; intent.mz = mv.mz; intent.speed = 3.4; intent.yaw = mv.yaw; }
      return intent;
    }
    intent.plant = true;
    intent.yaw = a.yaw;
    return intent;
  }
  if (bot.state === 'defuse') {
    const c = ctx.match.charge;
    const d = dist2d(a.x, a.z, c.x, c.z);
    if (d > 1.0) {
      const mv = followPathTo(bot, { x: c.x, z: c.z });
      if (mv) { intent.mx = mv.mx; intent.mz = mv.mz; intent.speed = 4.0; intent.yaw = mv.yaw; }
      return intent;
    }
    intent.defuse = true;
    return intent;
  }
  if (bot.state === 'pickup') {
    const c = ctx.match.charge;
    const d = dist2d(a.x, a.z, c.x, c.z);
    if (d > 0.9) {
      const mv = followPathTo(bot, { x: c.x, z: c.z });
      if (mv) { intent.mx = mv.mx; intent.mz = mv.mz; intent.speed = 4.0; intent.yaw = mv.yaw; }
      return intent;
    }
    return intent; // the loop picks the charge up on contact
  }

  // --- Move / hold --------------------------------------------------------
  if (bot.state === 'hold') {
    bot.holdT -= dt;
    intent.yaw = angleToward(a.yaw, bot.holdYaw, dt * 3);
    if (bot.investigate && bot.investigate.t > 0) {
      bot.investigate.t -= dt;
      intent.yaw = bot.holdYaw;
    } else if (bot.holdT <= 0) {
      // Reposition: pick a nearby waypoint to watch from.
      const near = nearestWaypoint(a.x, a.z);
      const cands = WAYPOINTS.filter((w) => dist2d(a.x, a.z, w.x, w.z) < 9 && w.id !== near);
      if (cands.length) {
        const w = cands[Math.floor(bot.rng() * cands.length)];
        bot.dest = { x: w.x, z: w.z };
        routeTo(bot, w.id);
        bot.state = 'move';
      }
      bot.holdT = 4 + bot.rng() * 4;
    }
    return intent;
  }

  // Move state: follow the path to the destination.
  if (bot.dest) {
    if (!bot.path.length) {
      const wp = nearestWaypoint(bot.dest.x, bot.dest.z);
      routeTo(bot, wp);
    }
    const mv = followPath(bot, 3.6);
    if (mv) {
      intent.mx = mv.mx; intent.mz = mv.mz; intent.speed = 3.6; intent.yaw = mv.yaw;
      return intent;
    }
    // Arrived: hold and watch.
    bot.state = 'hold';
    bot.holdT = 3 + bot.rng() * 4;
    bot.holdYaw = faceSiteYaw(a, bot);
    return intent;
  }
  return intent;
}

/** Walk straight toward a point (used for plant/defuse/pickup spots). */
function followPathTo(bot, p) {
  const a = bot.agent;
  const wp = nearestWaypoint(p.x, p.z);
  if (!bot.path.length || bot.path[bot.path.length - 1] !== wp) routeTo(bot, wp);
  const mv = followPath(bot, 3.6);
  if (mv) return mv;
  const d = dist2d(a.x, a.z, p.x, p.z);
  if (d < 0.7) return null;
  return { mx: (p.x - a.x) / d, mz: (p.z - a.z) / d, speed: 3.4, yaw: Math.atan2(p.x - a.x, -(p.z - a.z)) };
}

/** Objective decisions for a bot that is not fighting. */
function decideObjective(bot, ctx) {
  const a = bot.agent;
  const m = ctx.match;
  const c = m.charge;
  if (a.team === 'vanguard') {
    if (c.state === 'planted' || c.state === 'defusing') {
      // The closest living defender goes for the defuse; the rest hold.
      const mates = ctx.agents.filter((e) => e.alive && e.team === 'vanguard');
      mates.sort((p, q) => dist2d(p.x, p.z, c.x, c.z) - dist2d(q.x, q.z, c.x, c.z));
      if (mates[0] === a) { bot.state = 'defuse'; bot.path = []; return; }
      bot.state = 'hold';
      bot.holdYaw = Math.atan2(c.x - a.x, -(c.z - a.z));
      return;
    }
    if (bot.state !== 'hold' && bot.state !== 'move') bot.state = 'move';
    return;
  }
  // Ember (attackers).
  if (c.state === 'carried' && c.holderId === a.id) {
    const site = SITES[bot.assignedSite || 'A'];
    if (!bot.plantSpot) bot.plantSpot = randomSitePoint(site, bot.rng);
    bot.state = 'plant';
    bot.path = [];
    return;
  }
  if (c.state === 'dropped') {
    const mates = ctx.agents.filter((e) => e.alive && e.team === 'ember');
    mates.sort((p, q) => dist2d(p.x, p.z, c.x, c.z) - dist2d(q.x, q.z, c.x, c.z));
    if (mates[0] === a) { bot.state = 'pickup'; bot.path = []; return; }
  }
  if (c.state === 'planted' || c.state === 'planting' || c.state === 'defusing') {
    // Guard the planted charge from a distance.
    if (bot.state !== 'hold') {
      const site = SITES[c.site || 'A'];
      bot.dest = { x: site.x - 6, z: site.z + (bot.rng() - 0.5) * 6 };
      bot.state = 'move';
      bot.path = [];
    }
    return;
  }
  if (bot.state !== 'move' && bot.state !== 'hold') bot.state = 'move';
  if (!bot.dest) {
    const site = SITES[bot.assignedSite || 'A'];
    bot.dest = { x: site.x, z: site.z };
  }
}

/** A yaw that faces the bot's assigned site (or the yard centre). */
function faceSiteYaw(a, bot) {
  const site = SITES[bot.assignedSite || 'A'];
  if (a.team === 'vanguard') return Math.atan2(site.x - a.x, -(site.z - a.z));
  return Math.atan2(0 - a.x, -(0 - a.z));
}
