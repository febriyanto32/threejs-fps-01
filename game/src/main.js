// EMBERLINE — main.js
// The game loop: a fixed 1/60 s simulation kept apart from rendering, one
// state object, and the same shooting/movement code for the player and the
// bots. Rounds, economy and the charge live in match.js; this file wires
// input, bots, combat, grenades and the HUD together and hands the frame to
// render.js. A tiny debug handle (window.__ember) stages screenshots and
// drives headless checks; it only answers when ?debug=1 or ?shot= is set.

import * as THREE from 'three';
import { clamp, mulberry32, shuffled } from './util.js';
import { WORLD, SITES, SPAWNS, hasLineOfSight, siteAt, moveCircle } from './world.js';
import { WEAPONS, GRENADE, fireShot, currentSpreadDeg, damageAt, freshWeaponState, grenadeDamageAt } from './weapons.js';
import { createMatch, startRound, endRound, nextRound, onKill, pickupCharge, startPlant, startDefuse, cancelChannel, stepMatch, drainEvents, ECONOMY } from './match.js';
import { createBot, assignRoles, updateBot } from './bots.js';
import { freshBody, stepBody, applyMouse, eyePos, viewDir, damageAgent, respawnAgent, PLAYER } from './player.js';
import { createRenderer, renderFrame, resizeRenderer, botMesh, spawnTracer, spawnMuzzle, spawnSparks, spawnBlast, gunTipWorld } from './render.js';
import { createHud, updateHud } from './hud.js';
import * as audio from './audio.js';

const STEP = 1 / 60;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug') || params.has('shot');
const SHOT = params.get('shot');

const EMBER_NAMES = ['Rook', 'Vex', 'Ash', 'Flint'];
const VANGUARD_NAMES = ['Onyx', 'Slate', 'Birch', 'Wren', 'Moss'];

// --- Roster ---------------------------------------------------------------
function makeAgent(id, name, team, isPlayer) {
  return {
    id, name, team, isPlayer,
    ...freshBody(0, 0, team === 'ember' ? Math.PI / 2 : -Math.PI / 2),
    money: ECONOMY.startMoney,
    slots: { primary: freshWeaponState('p9'), pistol: freshWeaponState('p9') },
    weapon: null, // set below to the active slot
    grenades: 1,
    lastShotT: -99, lastHurtT: -99, kills: 0,
    bot: null, channel: null, // 'plant' | 'defuse' | null
    spreadDeg: 0,
  };
}

const agents = [];
const player = makeAgent('player', 'FBI', 'ember', true);
player.weapon = player.slots.pistol;
agents.push(player);
for (let i = 0; i < 4; i++) {
  const b = makeAgent('ember-' + i, EMBER_NAMES[i], 'ember', false);
  b.weapon = b.slots.pistol;
  agents.push(b);
}
for (let i = 0; i < 5; i++) {
  const b = makeAgent('vanguard-' + i, VANGUARD_NAMES[i], 'vanguard', false);
  b.weapon = b.slots.pistol;
  agents.push(b);
}
const bots = agents.filter((a) => !a.isPlayer).map((a) => {
  a.bot = createBot(a, mulberry32(0x9e37 + a.id.length * 131 + a.name.charCodeAt(0)));
  return a.bot;
});

// --- State ------------------------------------------------------------------
const match = createMatch();
const G = {
  match, agents, player,
  time: 0, timeScale: 1,
  started: false, over: false,
  input: { f: 0, b: 0, l: 0, r: 0, jump: false, crouch: false, plant: false, fire: false, scoped: false },
  mouseDX: 0, mouseDY: 0,
  grenadesLive: [],
  lastShot: null, // {x, z, shooter} — the most recent gunshot, for bot hearing
  spectate: null, // bot the camera follows when the player is down
  plantBeepT: 0,
  matchResetT: 0,
  freezeBots: false, // debug: hold every bot still (headless checks)
};

function aliveCount(team) {
  let n = 0;
  for (const a of agents) if (a.alive && a.team === team) n++;
  return n;
}

function emberBots() { return agents.filter((a) => a.team === 'ember' && !a.isPlayer); }

function pickCarrier() {
  const bs = emberBots();
  return bs[(match.round - 1) % bs.length];
}

// --- Round setup ------------------------------------------------------------
function setupRound() {
  const carrier = pickCarrier();
  const spawns = { ember: SPAWNS.ember.slice(), vanguard: SPAWNS.vanguard.slice() };
  for (const a of agents) {
    const list = spawns[a.team];
    const sp = list.shift() || { x: 0, z: 0 };
    respawnAgent(a, sp, a.team === 'ember' ? Math.PI / 2 : -Math.PI / 2);
    a.weapon = a.slots.primary.weaponId !== 'p9' ? a.slots.primary : a.slots.pistol;
    a.weapon.mag = WEAPONS[a.weapon.weaponId].mag;
    a.weapon.reserve = WEAPONS[a.weapon.weaponId].reserve;
    a.weapon.reloading = false;
    a.grenades = 1;
    a.channel = null;
    a.kills = 0;
  }
  // Bots buy with their money: rifle when rich, SMG mid, pistol when broke.
  for (const b of agents.filter((a) => !a.isPlayer)) {
    const w = b.money >= 2700 ? 'vk47' : b.money >= 1700 ? 'breacher' : b.money >= 1500 ? 'kestrel' : 'p9';
    b.slots.primary = freshWeaponState(w);
    b.weapon = b.slots.primary;
    if (w !== 'p9') b.money -= WEAPONS[w].price;
  }
  assignRoles(bots, match, mulberry32(0x51f + match.round * 7919));
  G.spectate = null;
  hud.showBuy(false);
  hud.hint(match.round === 1
    ? 'Buy phase — press B for the buy menu. Plant the charge at A or B.'
    : `Round ${match.round} — press B to buy.`);
  if (match.round === 1) hud.showBuy(true);
}

function resetMatch() {
  const m = createMatch();
  Object.assign(match, m);
  for (const a of agents) { a.money = ECONOMY.startMoney; a.slots.primary = freshWeaponState('p9'); a.slots.pistol = freshWeaponState('p9'); }
  player.weapon = player.slots.pistol;
  startRound(match, pickCarrier().id);
  setupRound();
}

// --- Combat -------------------------------------------------------------------
function muzzleOf(a) {
  const [ex, ey, ez] = eyePos(a);
  const d = viewDir(a);
  return [ex + d[0] * 0.5, ey + d[1] * 0.5 - 0.06, ez + d[2] * 0.5];
}

function tryFire(a) {
  const w = WEAPONS[a.weapon.weaponId];
  const ws = a.weapon;
  if (ws.cooldown > 0 || ws.reloading) return;
  if (ws.mag <= 0) { audio.playDryFire(); ws.cooldown = 0.25; startReload(a); return; }
  ws.cooldown = 60 / w.rpm;
  ws.mag -= 1;
  ws.heat = Math.min(1.6, ws.heat + w.heatPerShot);
  const [ox, oy, oz] = eyePos(a);
  const d = viewDir(a);
  const spread = currentSpreadDeg(w, a.speed, a.airborne, a.crouched);
  a.spreadDeg = spread;
  const rng = a.isPlayer ? Math.random : () => a.bot.rng();
  const targets = agents.filter((t) => t !== a && t.alive);
  const results = fireShot(ox, oy, oz, d[0], d[1], d[2], w, spread, targets, rng);
  // The flash and tracer start at the gun's muzzle: the viewmodel tip for
  // the player, the eye line for bots.
  const m = a.isPlayer ? gunTipWorld(R) : muzzleOf(a);
  // Recoil: the view kicks up and the gun kicks back.
  const recoil = w.recoil * (a.isPlayer ? 1 : 0.4);
  a.pitch = clamp(a.pitch + recoil * 0.011, -1.45, 1.45);
  a.yaw += (rng() - 0.5) * recoil * 0.006;
  a.weapon.recoilPitch = Math.min(1.6, (a.weapon.recoilPitch || 0) + w.kick * 0.12);
  a.lastShotT = G.time;
  G.lastShot = { x: a.x, z: a.z, shooter: a };
  audio.playShot(w.id, !a.isPlayer && Math.hypot(a.x - player.x, a.z - player.z) > 22);
  spawnMuzzle(R, m);
  if (a.bot) a.bot.burstLeft = Math.max(0, a.bot.burstLeft - 1);
  let hitSomething = false;
  for (const r of results) {
    spawnTracer(R, m, r.point, w.tracer);
    if (r.target) {
      hitSomething = true;
      const dmg = damageAt(w, r.dist, r.head);
      const res = damageAgent(r.target, dmg, a);
      spawnSparks(R, r.point, r.head ? 18 : 10);
      if (a.isPlayer) {
        hud.hitmarker(r.head, res === 'kill');
        audio.playHitmarker(r.head);
        if (res === 'kill') audio.playKill();
      }
      if (res === 'kill') handleKill(a, r.target, r.head);
      else if (r.target.isPlayer) { hud.damageFlash(); audio.playHurt(); }
    } else if (r.wall) {
      spawnSparks(R, r.point, 6);
    }
  }
  if (!hitSomething && a.isPlayer) { /* clean miss: no marker */ }
}

function handleKill(killer, victim, headshot) {
  onKill(match, killer.id, victim.id, headshot);
  killer.kills += 1;
  killer.money = Math.min(ECONOMY.maxMoney, killer.money + ECONOMY.killReward);
  if (victim.channel) { cancelChannel(match); victim.channel = null; }
  if (victim.isPlayer) {
    const allies = agents.filter((a) => a.alive && a.team === 'ember' && !a.isPlayer);
    G.spectate = allies[0] || null;
    hud.hint('You are down — spectating ' + (G.spectate ? G.spectate.name : '…'));
  }
}

function startReload(a) {
  const ws = a.weapon;
  const w = WEAPONS[ws.weaponId];
  if (ws.reloading || ws.mag >= w.mag || ws.reserve <= 0) return;
  ws.reloading = true;
  ws.reloadT = w.reloadS;
  if (a.isPlayer) audio.playReload();
}

function finishReload(a) {
  const ws = a.weapon;
  const w = WEAPONS[ws.weaponId];
  const need = w.mag - ws.mag;
  const take = ws.reserve === Infinity ? need : Math.min(need, ws.reserve);
  ws.mag += take;
  if (ws.reserve !== Infinity) ws.reserve -= take;
  ws.reloading = false;
}

function throwGrenade(a) {
  if (a.grenades <= 0) return;
  a.grenades -= 1;
  const [ex, ey, ez] = eyePos(a);
  const d = viewDir(a);
  G.grenadesLive.push({
    x: ex, y: ey, z: ez,
    vx: d[0] * GRENADE.throwSpeed, vy: d[1] * GRENADE.throwSpeed + 2.5, vz: d[2] * GRENADE.throwSpeed,
    fuse: GRENADE.fuseS, owner: a, bounced: false,
  });
  audio.playGrenadePin();
}

function explodeGrenade(g) {
  spawnBlast(R, [g.x, g.z]);
  audio.playExplosion();
  R.shake = Math.max(R.shake, 0.6);
  for (const t of agents) {
    if (!t.alive) continue;
    const dist = Math.hypot(t.x - g.x, (t.y + 0.9) - g.y, t.z - g.z);
    if (dist > GRENADE.radius) continue;
    const los = hasLineOfSight(g.x, g.z, t.x, t.z);
    const dmg = Math.round(grenadeDamageAt(dist) * (los ? 1 : 0.4));
    const res = damageAgent(t, dmg, g.owner);
    if (res === 'kill') handleKill(g.owner, t, false);
    else if (t.isPlayer) { hud.damageFlash(); audio.playHurt(); }
  }
}

// --- Buy menu -----------------------------------------------------------------
function buy(id) {
  if (match.phase !== 'buy') { hud.hint('Buying is only open in the buy phase.'); return; }
  if (id === 'grenade') {
    if (player.grenades >= 2) { hud.hint('Already carrying 2 frags.'); return; }
    if (player.money < GRENADE.price) { hud.hint('Not enough money for a frag.'); return; }
    player.money -= GRENADE.price;
    player.grenades += 1;
    audio.playBuy();
    hud.renderBuy();
    return;
  }
  const w = WEAPONS[id];
  if (!w) return;
  if (player.money < w.price) { hud.hint('Not enough money for ' + w.name + '.'); return; }
  if (player.slots.primary.weaponId === id) { hud.hint(w.name + ' already equipped.'); return; }
  player.money -= w.price;
  player.slots.primary = freshWeaponState(id);
  player.weapon = player.slots.primary;
  audio.playBuy();
  hud.hint(w.name + ' bought — good hunting.');
  hud.renderBuy();
}

function switchWeapon(slot) {
  const target = slot === 1 ? player.slots.primary : player.slots.pistol;
  if (player.weapon === target) return;
  if (player.weapon.reloading) player.weapon.reloading = false;
  player.weapon = target;
  audio.playClick();
}

// --- Plant / defuse channels ----------------------------------------------------
function channelStep(a, wantPlant, wantDefuse, dt) {
  const c = match.charge;
  const site = siteAt(a.x, a.z);
  // Keep an in-progress channel alive while the agent holds the button,
  // stays in place, and stays alive; otherwise it is interrupted.
  if (a.channel === 'plant') {
    if (!(wantPlant && c.state === 'planting' && c.holderId === a.id && site && a.alive)) {
      cancelChannel(match);
      a.channel = null;
    }
  } else if (a.channel === 'defuse') {
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    if (!(wantDefuse && c.state === 'defusing' && c.defuserId === a.id && d < 1.6 && a.alive)) {
      cancelChannel(match);
      a.channel = null;
    }
  } else if (a.team === 'ember' && wantPlant && c.state === 'carried' && c.holderId === a.id && site) {
    if (startPlant(match, a.id, site.id)) { a.channel = 'plant'; audio.playPlantBeep(); }
  } else if (a.team === 'vanguard' && wantDefuse && c.state === 'planted') {
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    if (d < 1.6 && startDefuse(match, a.id)) { a.channel = 'defuse'; audio.playDefuseBeep(); }
  }
  // Plant beeps tick once a second while planting.
  if (a.channel === 'plant') {
    G.plantBeepT -= dt;
    if (G.plantBeepT <= 0) { G.plantBeepT = 0.9; audio.playPlantBeep(); }
  }
}

// --- Fixed step -------------------------------------------------------------------
function step(dt) {
  G.time += dt;
  const m = match;

  // Round timers and phase changes.
  const wasPhase = m.phase;
  stepMatch(m, dt, { ember: aliveCount('ember'), vanguard: aliveCount('vanguard') });
  if (m.phase === 'over' && wasPhase !== 'over') {
    // Round just ended: pay out, sting, banner, blast if detonated.
    const payouts = m.events.find((e) => e.type === 'roundEnd');
    for (const a of agents) {
      if (a.alive) a.money = Math.min(ECONOMY.maxMoney, a.money + (payouts?.payouts[a.team] || 0));
    }
    if (m.winReason === 'detonation') { spawnBlast(R, [m.charge.x, m.charge.z]); audio.playExplosion(); }
    const won = m.winner === 'ember';
    audio.playRoundSting(won);
    const reasonText = {
      elimination: 'enemy team eliminated', detonation: 'charge detonated',
      defuse: 'charge defused', timeout: 'time expired — defenders hold',
    }[m.winReason] || '';
    hud.banner(
      won ? 'ROUND WON' : 'ROUND LOST',
      `Ember ${m.score.ember} — ${m.score.vanguard} Vanguard · ${reasonText}`,
      won ? 'win' : 'lose',
    );
    if (m.matchOver) {
      G.matchResetT = 6;
      hud.banner(
        m.matchWinner === 'ember' ? 'EMBER WINS THE MATCH' : 'VANGUARD WINS THE MATCH',
        `Final score Ember ${m.score.ember} — ${m.score.vanguard} Vanguard`,
        m.matchWinner === 'ember' ? 'win' : 'lose',
      );
    }
  }
  if (m.phase === 'over') {
    if (m.matchOver) {
      G.matchResetT -= dt;
      if (G.matchResetT <= 0) resetMatch();
    } else if (m.phaseT <= 0) {
      nextRound(match, pickCarrier().id);
      setupRound();
    }
  }

  // Player movement + look. Frozen during the buy phase, like a freeze time.
  if (G.started && player.alive && match.phase !== 'buy') {
    stepBody(player, G.input, dt);
    if (G.mouseDX || G.mouseDY) {
      applyMouse(player, G.mouseDX, G.mouseDY);
      G.mouseDX = 0; G.mouseDY = 0;
    }
    if (player.weapon.recoilPitch > 0) {
      player.weapon.recoilPitch = Math.max(0, player.weapon.recoilPitch - dt * 2.4);
    }
    if (player.weapon.heat > 0) player.weapon.heat = Math.max(0, player.weapon.heat - dt * 1.4);
  }

  // Bots: frozen during the buy phase, fighting once the round is live.
  // (G.freezeBots holds them still for headless checks.)
  const ctx = { agents, match: m, lastShot: G.lastShot };
  for (const b of bots) {
    const a = b.agent;
    if (!a.alive || m.phase !== 'live' || G.freezeBots) continue;
    const intent = updateBot(b, ctx, dt);
    // Movement: bots steer like the player, with acceleration.
    const sin = Math.sin(a.yaw), cos = Math.cos(a.yaw);
    const wish = { f: 0, b: 0, l: 0, r: 0, jump: false, crouch: intent.crouch };
    const il = Math.hypot(intent.mx, intent.mz) || 1;
    const mx = intent.mx / il, mz = intent.mz / il;
    const fwd = mx * sin + mz * -cos;
    const right = mx * cos + mz * sin;
    if (fwd > 0.15) wish.f = 1; else if (fwd < -0.15) wish.b = 1;
    if (right > 0.15) wish.r = 1; else if (right < -0.15) wish.l = 1;
    a.yaw = intent.yaw;
    a.pitch = intent.pitch;
    stepBody(a, wish, dt);
    if (a.weapon.cooldown > 0) a.weapon.cooldown -= dt;
    if (a.weapon.reloading) {
      a.weapon.reloadT -= dt;
      if (a.weapon.reloadT <= 0) finishReload(a);
    }
    if (intent.firing) tryFire(a);
    else if (a.weapon.mag === 0 && !a.weapon.reloading) startReload(a);
    channelStep(a, intent.plant, intent.defuse, dt);
  }

  // Player weapon timers, firing, reload.
  const pw = player.weapon;
  if (pw.cooldown > 0) pw.cooldown -= dt;
  if (pw.reloading) {
    pw.reloadT -= dt;
    if (pw.reloadT <= 0) finishReload(player);
  }
  if (G.started && player.alive && match.phase === 'live') {
    if (G.input.fire) tryFire(player);
    if (pw.mag === 0 && !pw.reloading) startReload(player);
  }
  channelStep(player, G.input.plant, G.input.plant, dt);

  // Charge pickup: any living ember agent walking over the dropped charge.
  if (m.charge.state === 'dropped') {
    for (const a of agents) {
      if (!a.alive || a.team !== 'ember') continue;
      if (Math.hypot(a.x - m.charge.x, a.z - m.charge.z) < 1.1) {
        pickupCharge(m, a.id);
        if (a.isPlayer) hud.hint('You picked up the charge — plant it at A or B.');
        break;
      }
    }
  }

  // Grenades in flight.
  for (let i = G.grenadesLive.length - 1; i >= 0; i--) {
    const g = G.grenadesLive[i];
    g.fuse -= dt;
    g.vy -= GRENADE.gravity * dt;
    g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
    const [nx, nz] = moveCircle(g.x, g.z, 0, 0, 0.1);
    g.x = nx; g.z = nz;
    if (g.y <= 0.12) {
      g.y = 0.12;
      if (!g.bounced) { g.bounced = true; audio.playGrenadeBounce(); }
      g.vy = Math.abs(g.vy) * 0.35;
      g.vx *= 0.6; g.vz *= 0.6;
    }
    if (g.fuse <= 0) { explodeGrenade(g); G.grenadesLive.splice(i, 1); }
  }

  // Match events -> HUD + sounds.
  for (const e of drainEvents(m)) {
    if (e.type === 'kill') {
      hud.feed(e.text, e.killer === 'player' ? 'good' : e.victim === 'player' ? 'bad' : '');
    } else if (e.type === 'planted') {
      hud.feed(e.text, 'warn');
      hud.hint('Charge planted! Defenders have 35 seconds.');
      audio.playPlantBeep(true);
    } else if (e.type === 'chargeDropped') {
      hud.feed(e.text, 'warn');
    } else if (e.type === 'round') {
      hud.feed(e.text, '');
    }
  }
}

// --- Render state ---------------------------------------------------------------
function renderState() {
  const c = match.charge;
  const holder = c.holderId ? agents.find((a) => a.id === c.holderId) : null;
  const cam = G.spectate && !player.alive ? G.spectate : player;
  const [ex, ey] = eyePos(cam);
  return {
    player: {
      x: cam.x, z: cam.z, y: cam.y, eyeY: ey,
      yaw: cam.yaw, pitch: cam.pitch, hp: player.hp,
      speed: cam.speed, weapon: player.weapon,
      spreadDeg: player.spreadDeg || 0,
    },
    agents,
    charge: {
      state: c.state, x: c.x, z: c.z, holder,
      holderIsPlayer: c.holderId === 'player',
      holderName: holder ? holder.name : '',
      fuseT: c.fuseT, plantT: c.plantT, defuseT: c.defuseT,
    },
    scoped: G.input.scoped && player.weapon.weaponId === 'longbow' && player.alive,
  };
}

function hudState() {
  const c = match.charge;
  const holder = c.holderId ? agents.find((a) => a.id === c.holderId) : null;
  return {
    player, money: player.money,
    phase: match.phase, phaseT: match.phaseT, roundT: match.roundT,
    round: match.round, score: match.score,
    alive: { ember: aliveCount('ember'), vanguard: aliveCount('vanguard') },
    charge: {
      state: c.state, holderIsPlayer: c.holderId === 'player',
      holderName: holder ? holder.name : '',
      fuseT: c.fuseT, plantT: c.plantT, defuseT: c.defuseT,
    },
    scoped: G.input.scoped && player.weapon.weaponId === 'longbow' && player.alive,
  };
}

// --- Boot -----------------------------------------------------------------------
const canvas = document.getElementById('game');
const R = createRenderer(canvas);
const hud = createHud({
  money: () => player.money,
  weaponId: () => player.weapon.weaponId,
  buy: (id) => buy(id),
});
resizeRenderer(R, window.innerWidth, window.innerHeight);
window.addEventListener('resize', () => resizeRenderer(R, window.innerWidth, window.innerHeight));

const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');

function startGame() {
  audio.unlockAudio();
  startScreen.classList.add('hidden');
  G.started = true;
  canvas.requestPointerLock?.();
  if (match.round === 1 && match.phase === 'buy') hud.showBuy(true);
}

startBtn.addEventListener('click', startGame);
canvas.addEventListener('click', () => {
  if (G.started && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});

// Input: keyboard.
const KEYMAP = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'l', ArrowRight: 'r' };
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const dir = KEYMAP[e.code];
  if (dir) { G.input[dir] = 1; e.preventDefault(); }
  if (e.code === 'Space') { G.input.jump = true; e.preventDefault(); }
  if (e.code === 'ControlLeft' || e.code === 'KeyC') G.input.crouch = true;
  if (e.code === 'KeyE') G.input.plant = true;
  if (e.code === 'KeyR') startReload(player);
  if (e.code === 'KeyG') throwGrenade(player);
  if (e.code === 'Digit1') switchWeapon(1);
  if (e.code === 'Digit2') switchWeapon(2);
  if (e.code === 'KeyB') { hud.showBuy(!hud.buyOpen); audio.playClick(); }
  if (e.code === 'KeyM') audio.setMuted(!audio.isMuted());
});
window.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.code];
  if (dir) G.input[dir] = 0;
  if (e.code === 'Space') G.input.jump = false;
  if (e.code === 'ControlLeft' || e.code === 'KeyC') G.input.crouch = false;
  if (e.code === 'KeyE') G.input.plant = false;
});
window.addEventListener('mousedown', (e) => {
  if (!G.started || hud.buyOpen) return;
  if (e.button === 0) G.input.fire = true;
  if (e.button === 2) G.input.scoped = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) G.input.fire = false;
  if (e.button === 2) G.input.scoped = false;
});
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  G.mouseDX += e.movementX;
  G.mouseDY += e.movementY;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) G.input.fire = false;
});

// Zoom the sniper scope: narrow the FOV while scoped.
let baseFov = 78;

// Main loop.
startRound(match, pickCarrier().id);
setupRound();
let last = performance.now();
let acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * G.timeScale;
  let n = 0;
  while (acc >= STEP && n < 8) { step(STEP); acc -= STEP; n++; }
  const s = renderState();
  const wantFov = s.scoped ? baseFov / 4 : baseFov;
  if (Math.abs(R.camera.fov - wantFov) > 0.1) {
    R.camera.fov += (wantFov - R.camera.fov) * 0.25;
    R.camera.updateProjectionMatrix();
  }
  renderFrame(R, s, dt, G.time);
  updateHud(hud, hudState());
  if (!G.started) {
    // Attract mode behind the start screen: slow orbit over the yard.
    const t = G.time * 0.05;
    R.camera.position.set(Math.sin(t) * 16, 9, Math.cos(t) * 13);
    R.camera.lookAt(0, 1, 0);
    R.renderer.render(R.scene, R.camera);
  }
}
requestAnimationFrame(frame);

// --- Debug handle + screenshot staging ------------------------------------------
function snapshot() {
  return {
    phase: match.phase, phaseT: +match.phaseT.toFixed(2), time: +G.time.toFixed(2),
    round: match.round, roundT: +match.roundT.toFixed(2),
    score: { ...match.score }, winner: match.winner, winReason: match.winReason,
    matchOver: match.matchOver, matchWinner: match.matchWinner,
    charge: { ...match.charge },
    player: { x: +player.x.toFixed(2), z: +player.z.toFixed(2), hp: player.hp, alive: player.alive, money: player.money, weapon: player.weapon.weaponId, mag: player.weapon.mag },
    alive: { ember: aliveCount('ember'), vanguard: aliveCount('vanguard') },
    agents: agents.map((a) => ({ id: a.id, team: a.team, x: +a.x.toFixed(1), z: +a.z.toFixed(1), hp: a.hp, alive: a.alive })),
  };
}

function skipBuy() {
  if (match.phase === 'buy') { match.phaseT = 0.01; }
}

function stageShot(name) {
  G.started = true;
  startScreen.classList.add('hidden');
  hud.showBuy(false); // the boot buy menu must not cover a staged scene
  G.freezeBots = true; // hold the scene still so the frame stays composed
  if (name === 'firefight') {
    match.phase = 'live'; match.roundT = 88;
    player.slots.primary = freshWeaponState('vk47');
    player.weapon = player.slots.primary;
    player.money = 3250;
    // Mid lane, clear sightline east: two Vanguard bots ahead, lit by the sun.
    respawnAgent(player, { x: -1, z: 0 }, Math.PI / 2);
    const e0 = agents.find((a) => a.id === 'vanguard-0');
    const e1 = agents.find((a) => a.id === 'vanguard-1');
    // Face them at the player so their visors and name tags read in frame.
    respawnAgent(e0, { x: 4, z: -1 }, Math.atan2(-1 - 4, -(0 - (-1))));
    respawnAgent(e1, { x: 6.5, z: 1.5 }, Math.atan2(-1 - 6.5, -(0 - 1.5)));
    const ally = agents.find((a) => a.id === 'ember-0');
    respawnAgent(ally, { x: -3, z: -3 }, Math.PI / 2);
  } else if (name === 'plant') {
    match.phase = 'live'; match.roundT = 61;
    G.input.plant = true; // hold E so the staged channel is not cancelled
    // Inside Site A, facing the site centre: decal, beam and plant bar read.
    respawnAgent(player, { x: 12.5, z: -11.5 }, Math.PI / 2);
    player.slots.primary = freshWeaponState('vk47');
    player.weapon = player.slots.primary;
    match.charge.state = 'carried';
    match.charge.holderId = 'player';
    startPlant(match, 'player', 'A');
    match.charge.plantT = 1.4;
    player.channel = 'plant';
    const ally = agents.find((a) => a.id === 'ember-1');
    respawnAgent(ally, { x: 10, z: -8 }, Math.PI / 2);
    const guard = agents.find((a) => a.id === 'vanguard-2');
    respawnAgent(guard, { x: 17, z: -8 }, Math.atan2(12.5 - 17, -(-11.5 - (-8))));
  } else if (name === 'buymenu') {
    match.phase = 'buy'; match.phaseT = 12;
    player.money = 3250;
    // Face north-east toward the sunlit stack so the yard glows behind the menu.
    respawnAgent(player, { x: -16, z: -2 }, 0.7);
    hud.showBuy(true);
  } else if (name === 'roundwin') {
    match.score.ember = 3; match.score.vanguard = 1;
    endRound(match, 'ember', 'detonation');
    match.charge.state = 'detonated';
    match.charge.x = SITES.A.x; match.charge.z = SITES.A.z;
    spawnBlast(R, [SITES.A.x, SITES.A.z]);
    hud.banner('ROUND WON', 'Ember 4 — 1 Vanguard · charge detonated', 'win');
    // Face the blast at Site A from the mid yard.
    respawnAgent(player, { x: 8, z: -6 }, 0.94);
  }
}

const debugApi = DEBUG ? {
  setTimeScale(n) { G.timeScale = n; },
  /** Run the fixed-step sim forward synchronously (headless fast-forward). */
  advance(seconds) {
    const steps = Math.max(0, Math.round(seconds / STEP));
    for (let i = 0; i < steps; i++) step(STEP);
  },
  /** Hold every bot still (on) or let them play (off). */
  freezeBots(on) { G.freezeBots = !!on; },
  /** Hold (or release) the plant/defuse key as the player. */
  holdPlant(on) { G.input.plant = !!on; },
  skipBuy,
  forcePlant(site = 'A') {
    match.phase = 'live';
    const holder = match.charge.holderId;
    if (match.charge.state === 'carried' && holder) startPlant(match, holder, site);
    else { match.charge.state = 'planted'; match.charge.site = site; match.charge.fuseT = WORLD.fuseTime; }
  },
  forceTimeout() { match.roundT = 0.05; },
  killCarrier() {
    const h = match.charge.holderId;
    const a = agents.find((x) => x.id === h);
    if (a) { damageAgent(a, 9999, player); handleKill(player, a, false); }
  },
  teleport(x, z, yaw) { player.x = x; player.z = z; if (yaw !== undefined) player.yaw = yaw; },
  giveMoney(n) { player.money = n; },
  openBuy() { hud.showBuy(true); },
  shootOnce() { tryFire(player); },
  killAll(team) { for (const a of agents) if (a.team === team && a.alive) { damageAgent(a, 9999, player); handleKill(player, a, false); } },
  stageShot,
  state: snapshot,
} : { state: snapshot };

window.__ember = {
  ready: true,
  state: snapshot,
  debug: debugApi,
};

if (SHOT) stageShot(SHOT);
