// EMBERLINE — hud.js
// The HUD: one DOM overlay, updated by writing text and widths only when
// values change, so the render loop never rebuilds nodes. It owns the buy
// menu, the kill feed, the round banners and the hitmarker — everything the
// player reads — and nothing else. All styling lives in index.html.

import { fmtMoney, fmtTime } from './util.js';
import { WEAPONS, BUY_ORDER, GRENADE } from './weapons.js';

const $ = (id) => document.getElementById(id);

export function createHud(callbacks) {
  const el = {
    root: $('hud'), health: $('hud-health'), healthBar: $('hud-health-bar'),
    money: $('hud-money'), ammo: $('hud-ammo'), reserve: $('hud-reserve'),
    weapon: $('hud-weapon'), nades: $('hud-nades'), timer: $('hud-timer'),
    scoreEmber: $('hud-score-ember'), scoreVanguard: $('hud-score-vanguard'),
    round: $('hud-round'), aliveEmber: $('hud-alive-ember'),
    aliveVanguard: $('hud-alive-vanguard'), bomb: $('hud-bomb'),
    cross: $('crosshair'), hitmark: $('hitmarker'), feed: $('killfeed'),
    banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
    buy: $('buy-menu'), buyGrid: $('buy-grid'), buyMoney: $('buy-money'),
    vignette: $('damage-vignette'), plantBar: $('plant-bar'),
    plantFill: $('plant-fill'), plantLabel: $('plant-label'),
    scope: $('scope-overlay'), hint: $('hint'), charge: $('hud-charge'),
  };
  const hud = {
    el, cb: callbacks,
    last: {},
    buyOpen: false,
    selectedBuy: null,
    // Write a value only when it changed (avoids layout work every frame).
    set(key, node, value) {
      if (hud.last[key] !== value) { hud.last[key] = value; node.textContent = value; }
    },
    showBuy(open) {
      hud.buyOpen = open;
      el.buy.classList.toggle('hidden', !open);
      if (open) hud.renderBuy();
    },
    renderBuy() {
      el.buyMoney.textContent = fmtMoney(hud.cb.money());
      el.buyGrid.innerHTML = '';
      for (const id of BUY_ORDER) {
        const w = WEAPONS[id];
        const owned = hud.cb.weaponId() === id;
        const afford = hud.cb.money() >= w.price;
        const card = document.createElement('button');
        card.className = 'buy-card' + (owned ? ' owned' : '') + (afford ? '' : ' poor');
        card.innerHTML = `<b>${w.name}</b><span>${w.damage} dmg · ${w.mag} rnd · ${w.rpm} rpm</span><em>${owned ? 'EQUIPPED' : fmtMoney(w.price)}</em>`;
        card.onclick = () => hud.cb.buy(id);
        el.buyGrid.appendChild(card);
      }
      const g = document.createElement('button');
      g.className = 'buy-card' + (hud.cb.money() >= GRENADE.price ? '' : ' poor');
      g.innerHTML = `<b>${GRENADE.name}</b><span>blast ${GRENADE.damage} · radius ${GRENADE.radius} m</span><em>${fmtMoney(GRENADE.price)}</em>`;
      g.onclick = () => hud.cb.buy('grenade');
      el.buyGrid.appendChild(g);
    },
    feed(text, cls = '') {
      const line = document.createElement('div');
      line.className = 'feed-line ' + cls;
      line.textContent = text;
      el.feed.prepend(line);
      while (el.feed.children.length > 5) el.feed.lastChild.remove();
      setTimeout(() => line.classList.add('fade'), 4200);
    },
    banner(title, sub, cls = '') {
      el.bannerTitle.textContent = title;
      el.bannerSub.textContent = sub;
      el.banner.className = 'show ' + cls;
      clearTimeout(hud._bannerT);
      hud._bannerT = setTimeout(() => { el.banner.className = ''; }, 4000);
    },
    hitmarker(headshot, kill) {
      el.hitmark.className = 'show' + (headshot ? ' head' : '') + (kill ? ' kill' : '');
      clearTimeout(hud._hitT);
      hud._hitT = setTimeout(() => { el.hitmark.className = ''; }, 130);
    },
    damageFlash() {
      el.vignette.classList.add('show');
      setTimeout(() => el.vignette.classList.remove('show'), 180);
    },
    hint(text, ms = 3500) {
      el.hint.textContent = text;
      el.hint.classList.remove('hidden');
      clearTimeout(hud._hintT);
      hud._hintT = setTimeout(() => el.hint.classList.add('hidden'), ms);
    },
  };
  return hud;
}

/** Per-frame HUD refresh from the live game state. */
export function updateHud(hud, s) {
  const el = hud.el;
  const p = s.player;
  hud.set('hp', el.health, String(Math.ceil(p.hp)));
  el.healthBar.style.width = Math.max(0, p.hp) + '%';
  el.healthBar.classList.toggle('low', p.hp <= 30);
  hud.set('money', el.money, fmtMoney(s.money));
  hud.set('ammo', el.ammo, p.weapon.reloading ? '--' : String(p.weapon.mag));
  hud.set('reserve', el.reserve, p.weapon.reserve === Infinity ? '∞' : String(p.weapon.reserve));
  hud.set('weapon', el.weapon, WEAPONS[p.weapon.weaponId].name);
  hud.set('nades', el.nades, '◉'.repeat(p.weapon.grenades));
  hud.set('timer', el.timer, s.phase === 'buy' ? 'BUY ' + fmtTime(s.phaseT) : fmtTime(s.roundT));
  el.timer.classList.toggle('urgent', s.phase === 'live' && s.roundT < 15);
  hud.set('round', el.round, `ROUND ${s.round} / 9`);
  hud.set('se', el.scoreEmber, String(s.score.ember));
  hud.set('sv', el.scoreVanguard, String(s.score.vanguard));
  hud.set('ae', el.aliveEmber, '●'.repeat(s.alive.ember) + '○'.repeat(5 - s.alive.ember));
  hud.set('av', el.aliveVanguard, '●'.repeat(s.alive.vanguard) + '○'.repeat(5 - s.alive.vanguard));

  // Bomb status pill.
  const c = s.charge;
  let bombText = '', bombCls = '';
  if (c.state === 'carried') { bombText = c.holderIsPlayer ? 'YOU CARRY THE CHARGE — plant at A or B' : 'CHARGE WITH ' + c.holderName; bombCls = 'carry'; }
  else if (c.state === 'dropped') { bombText = 'CHARGE DROPPED — pick it up'; bombCls = 'dropped'; }
  else if (c.state === 'planting') { bombText = 'PLANTING…'; bombCls = 'planting'; }
  else if (c.state === 'planted') { bombText = 'CHARGE PLANTED — ' + fmtTime(c.fuseT) + ' TO BLAST'; bombCls = 'planted'; }
  else if (c.state === 'defusing') { bombText = 'DEFUSING… ' + Math.ceil(c.defuseT) + 's'; bombCls = 'defusing'; }
  else if (c.state === 'detonated') { bombText = 'CHARGE DETONATED'; bombCls = 'planted'; }
  else if (c.state === 'defused') { bombText = 'CHARGE DEFUSED'; bombCls = 'defused'; }
  hud.set('bomb', el.bomb, bombText);
  el.bomb.className = 'bomb ' + bombCls;

  // Plant / defuse progress ring (a thin bar under the crosshair).
  if (c.state === 'planting' || c.state === 'defusing') {
    const total = c.state === 'planting' ? 3 : 5;
    const left = c.state === 'planting' ? c.plantT : c.defuseT;
    el.plantBar.classList.remove('hidden');
    el.plantFill.style.width = ((1 - left / total) * 100).toFixed(1) + '%';
    el.plantLabel.textContent = c.state === 'planting' ? 'PLANTING' : 'DEFUSING';
  } else {
    el.plantBar.classList.add('hidden');
  }

  // Crosshair spread: the gap grows with the shooter's current spread.
  const gap = 5 + (p.spreadDeg || 0) * 2.2;
  el.cross.style.setProperty('--gap', gap.toFixed(1) + 'px');
  el.cross.classList.toggle('scoped', !!s.scoped);
  el.scope.classList.toggle('hidden', !s.scoped);
  el.charge.classList.toggle('hidden', c.state !== 'carried' || !c.holderIsPlayer);
}
