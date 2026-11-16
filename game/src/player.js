// EMBERLINE — player.js
// The first-person controller: mouse look with pointer lock, WASD movement
// with acceleration and friction (so stopping to aim pays), crouch and
// jump, and health. It owns no rendering and no DOM: input arrives as a
// plain key/mouse state object, and the loop feeds it the fixed step.

import { clamp } from './util.js';
import { moveCircle } from './world.js';

export const PLAYER = {
  radius: 0.42,
  eyeStand: 1.62,
  eyeCrouch: 1.05,
  walkSpeed: 4.2,
  crouchSpeed: 2.1,
  accel: 42,
  friction: 11,
  jumpVel: 5.4,
  gravity: 14.5,
  maxHp: 100,
};

/** Fresh player body state (an agent the controller drives). */
export function freshBody(x, z, yaw) {
  return {
    x, z, y: 0, vy: 0, yaw, pitch: 0,
    vx: 0, vz: 0, crouched: false, airborne: false,
    hp: PLAYER.maxHp, alive: true, speed: 0,
  };
}

/**
 * Step the body one fixed tick. `input` is {f, b, l, r, jump, crouch} with
 * 0/1 values. Returns nothing; the body is mutated in place.
 */
export function stepBody(body, input, dt) {
  if (!body.alive) { body.vx = 0; body.vz = 0; body.speed = 0; return; }
  const wantCrouch = !!input.crouch;
  body.crouched = wantCrouch;
  const maxSpeed = wantCrouch ? PLAYER.crouchSpeed : PLAYER.walkSpeed;

  // Wish direction in world space, from the yaw.
  const sin = Math.sin(body.yaw), cos = Math.cos(body.yaw);
  let wx = 0, wz = 0;
  if (input.f) { wx += sin; wz += -cos; }
  if (input.b) { wx -= sin; wz += cos; }
  if (input.r) { wx += cos; wz += sin; }
  if (input.l) { wx -= cos; wz += -sin; }
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }

  // Accelerate toward the wish velocity; friction when no input.
  body.vx += wx * PLAYER.accel * dt;
  body.vz += wz * PLAYER.accel * dt;
  const sp = Math.hypot(body.vx, body.vz);
  const cap = wl > 0 ? maxSpeed : 0;
  if (sp > cap) {
    const dec = Math.min(sp - cap, PLAYER.friction * dt * (wl > 0 ? 1 : 2.2));
    const ns = Math.max(0, sp - dec);
    body.vx = (body.vx / sp) * ns;
    body.vz = (body.vz / sp) * ns;
  }
  const [nx, nz] = moveCircle(body.x, body.z, body.vx * dt, body.vz * dt, PLAYER.radius);
  body.x = nx; body.z = nz;
  body.speed = Math.hypot(body.vx, body.vz);

  // Jump and gravity.
  if (input.jump && !body.airborne) {
    body.vy = PLAYER.jumpVel;
    body.airborne = true;
  }
  if (body.airborne) {
    body.vy -= PLAYER.gravity * dt;
    body.y += body.vy * dt;
    if (body.y <= 0) { body.y = 0; body.vy = 0; body.airborne = false; }
  }
}

/** Apply a mouse delta to the view (pointer lock gives movementX/Y). */
export function applyMouse(body, dx, dy, sensitivity = 0.0021) {
  body.yaw -= dx * sensitivity;
  body.pitch = clamp(body.pitch - dy * sensitivity, -1.45, 1.45);
}

/** Current eye position as [x, y, z]. */
export function eyePos(body) {
  return [body.x, body.y + (body.crouched ? PLAYER.eyeCrouch : PLAYER.eyeStand), body.z];
}

/** Current view direction as a unit [x, y, z]. */
export function viewDir(body) {
  const cp = Math.cos(body.pitch);
  return [Math.sin(body.yaw) * cp, Math.sin(body.pitch), -Math.cos(body.yaw) * cp];
}

/**
 * Damage an agent: returns 'hit' | 'kill'. A kill marks the agent dead and
 * drops its velocity; the caller credits the killer and the charge.
 */
export function damageAgent(target, dmg, attacker) {
  if (!target.alive) return 'hit';
  target.hp -= dmg;
  target.lastAttacker = attacker;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.vx = 0; target.vz = 0;
    return 'kill';
  }
  return 'hit';
}

/** Respawn an agent at a spawn point with full health and a fresh body. */
export function respawnAgent(agent, spawn, yaw) {
  agent.x = spawn.x; agent.z = spawn.z;
  agent.y = 0; agent.vy = 0; agent.vx = 0; agent.vz = 0;
  agent.yaw = yaw; agent.pitch = 0;
  agent.hp = PLAYER.maxHp; agent.alive = true;
  agent.crouched = false; agent.airborne = false;
  agent.speed = 0;
}
