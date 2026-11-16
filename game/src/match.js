// EMBERLINE — match.js
// The match state machine: rounds, economy, the charge, and win detection.
// Pure logic — no DOM, no three.js — so the same code runs in the browser
// and in headless tests. The game loop owns agents and positions; this
// module owns the rules and answers one question per call: what changed?
//
// Teams: 'ember' attacks (plants the charge), 'vanguard' defends.
// A round ends on elimination, detonation, defuse, or the timer running out
// (defenders win a timeout). First to 5 rounds wins the match, at most 9.

import { WORLD } from './world.js';

export const ECONOMY = {
  startMoney: 800,
  killReward: 300,
  plantReward: 300,
  winBonus: 3250,
  lossBonus: 1900,
  lossStreakBonus: 500,   // per consecutive loss, on top of lossBonus
  lossStreakCap: 1500,
  maxMoney: 16000,
};

export const ROLES = {
  carrier: 'carrier',     // the ember agent carrying the charge
};

/** Fresh match state. `agentIds` maps team -> [ids] for score bookkeeping. */
export function createMatch() {
  return {
    round: 1,
    score: { ember: 0, vanguard: 0 },
    phase: 'buy',          // 'buy' | 'live' | 'over'
    phaseT: WORLD.buyTime, // seconds left in the current phase
    roundT: WORLD.roundTime,
    winner: null,          // 'ember' | 'vanguard' | null
    winReason: null,       // 'elimination' | 'detonation' | 'defuse' | 'timeout'
    matchOver: false,
    matchWinner: null,
    // The charge: carried -> dropped -> planted -> defused | detonated.
    charge: {
      state: 'carried', holderId: null, x: 0, z: 0,
      site: null, plantT: 0, defuseT: 0, fuseT: 0, defuserId: null,
    },
    lossStreak: { ember: 0, vanguard: 0 },
    events: [],            // human-readable feed entries, drained by the HUD
    lastKiller: null,
  };
}

/** Begin a round: buy phase, charge back on its carrier, timers reset. */
export function startRound(m, carrierId) {
  m.phase = 'buy';
  m.phaseT = WORLD.buyTime;
  m.roundT = WORLD.roundTime;
  m.winner = null;
  m.winReason = null;
  m.charge = {
    state: 'carried', holderId: carrierId, x: 0, z: 0,
    site: null, plantT: 0, defuseT: 0, fuseT: 0, defuserId: null,
  };
  m.events.push({ type: 'round', round: m.round, text: `Round ${m.round} — buy phase` });
}

/** Money deltas for a round result, per team. */
export function roundPayouts(m, winnerTeam) {
  const out = {};
  for (const team of ['ember', 'vanguard']) {
    if (team === winnerTeam) {
      out[team] = ECONOMY.winBonus;
      m.lossStreak[team] = 0;
    } else {
      m.lossStreak[team] += 1;
      out[team] = ECONOMY.lossBonus + Math.min(
        ECONOMY.lossStreakCap,
        ECONOMY.lossStreakBonus * (m.lossStreak[team] - 1),
      );
    }
  }
  return out;
}

/** End the round: score it, pay out, and decide whether the match is over. */
export function endRound(m, winnerTeam, reason) {
  if (m.phase === 'over') return;
  m.phase = 'over';
  m.phaseT = 4.5;
  m.winner = winnerTeam;
  m.winReason = reason;
  m.score[winnerTeam] += 1;
  const payouts = roundPayouts(m, winnerTeam);
  m.events.push({
    type: 'roundEnd', winner: winnerTeam, reason,
    text: winnerTeam === 'ember' ? 'Ember takes the round' : 'Vanguard takes the round',
    payouts,
  });
  if (m.score[winnerTeam] >= 5 || m.round >= 9) {
    m.matchOver = true;
    m.matchWinner = m.score.ember > m.score.vanguard ? 'ember'
      : m.score.vanguard > m.score.ember ? 'vanguard' : null;
  }
}

/** Advance to the next round (called by the loop after the 'over' pause). */
export function nextRound(m, carrierId) {
  m.round += 1;
  startRound(m, carrierId);
}

/** A kill: credit the killer, and drop the charge if the carrier died. */
export function onKill(m, killerId, victimId, headshot) {
  m.lastKiller = killerId;
  m.events.push({
    type: 'kill', killer: killerId, victim: victimId, headshot: !!headshot,
    text: `${killerId} ▸ ${victimId}${headshot ? ' (headshot)' : ''}`,
  });
  if ((m.charge.state === 'carried' || m.charge.state === 'planting') && m.charge.holderId === victimId) {
    m.charge.state = 'dropped';
    m.charge.holderId = null;
    m.charge.site = null;
    m.charge.plantT = 0;
    m.events.push({ type: 'chargeDropped', text: 'The charge was dropped!' });
  }
}

/** A live agent walks over the dropped charge and picks it up. */
export function pickupCharge(m, agentId) {
  if (m.charge.state !== 'dropped') return false;
  m.charge.state = 'carried';
  m.charge.holderId = agentId;
  m.events.push({ type: 'chargePickup', text: `${agentId} picked up the charge` });
  return true;
}

/** Begin a plant channel at a site; returns false when planting is illegal. */
export function startPlant(m, agentId, siteId) {
  if (m.phase !== 'live') return false;
  if (m.charge.state !== 'carried' || m.charge.holderId !== agentId) return false;
  m.charge.state = 'planting';
  m.charge.site = siteId;
  m.charge.plantT = WORLD.plantTime;
  m.events.push({ type: 'plantStart', text: `${agentId} is planting at Site ${siteId}` });
  return true;
}

/** Begin a defuse channel; returns false when defusing is illegal. */
export function startDefuse(m, agentId) {
  if (m.phase !== 'live') return false;
  if (m.charge.state !== 'planted') return false;
  m.charge.state = 'defusing';
  m.charge.defuseT = WORLD.defuseTime;
  m.charge.defuserId = agentId;
  m.events.push({ type: 'defuseStart', text: `${agentId} is defusing the charge` });
  return true;
}

/** Cancel an in-progress plant or defuse (mover shot, walked away, died). */
export function cancelChannel(m) {
  if (m.charge.state === 'planting') {
    m.charge.state = 'carried';
    m.charge.site = null;
    m.charge.plantT = 0;
  } else if (m.charge.state === 'defusing') {
    m.charge.state = 'planted';
    m.charge.defuseT = 0;
    m.charge.defuserId = null;
  }
}

/**
 * Advance timers by dt seconds. `alive` maps team -> living count, read by
 * the loop each step. Returns nothing; round ends are recorded in the state
 * (phase 'over', winner, winReason) for the loop to act on.
 */
export function stepMatch(m, dt, alive) {
  if (m.phase === 'buy') {
    m.phaseT -= dt;
    if (m.phaseT <= 0) {
      m.phase = 'live';
      m.events.push({ type: 'live', text: 'Round live — go!' });
    }
    return;
  }
  if (m.phase === 'over') {
    m.phaseT -= dt;
    return;
  }
  // Live phase.
  m.roundT -= dt;
  if (m.charge.state === 'planting') {
    m.charge.plantT -= dt;
    if (m.charge.plantT <= 0) {
      m.charge.state = 'planted';
      m.charge.fuseT = WORLD.fuseTime;
      m.events.push({ type: 'planted', text: `Charge planted at Site ${m.charge.site}!` });
    }
  } else if (m.charge.state === 'defusing') {
    m.charge.defuseT -= dt;
    if (m.charge.defuseT <= 0) {
      m.charge.state = 'defused';
      endRound(m, 'vanguard', 'defuse');
      return;
    }
  } else if (m.charge.state === 'planted') {
    m.charge.fuseT -= dt;
    if (m.charge.fuseT <= 0) {
      m.charge.state = 'detonated';
      endRound(m, 'ember', 'detonation');
      return;
    }
  }
  if (alive.ember === 0 && alive.vanguard > 0) {
    endRound(m, 'vanguard', 'elimination');
    return;
  }
  if (alive.vanguard === 0 && alive.ember > 0) {
    endRound(m, 'ember', 'elimination');
    return;
  }
  if (m.roundT <= 0) {
    if (m.charge.state === 'planted' || m.charge.state === 'defusing') {
      // The fuse decides it; keep the round alive until it resolves.
      m.roundT = 0;
    } else {
      endRound(m, 'vanguard', 'timeout');
    }
  }
}

/** Drain queued events (the HUD consumes them each frame). */
export function drainEvents(m) {
  const out = m.events;
  m.events = [];
  return out;
}
