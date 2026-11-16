// The DOM HUD: crosshair, hit marker, health, ammo, timer, score, killfeed,
// bomb status and the buy menu. It never touches the simulation; main.js pushes
// numbers in and reads callbacks out. Every setter is cached, so the DOM is only
// written when a value actually changes.
import { WEAPONS, GRENADE_PRICE, ARMOR_PRICE } from './weapons.js';

const COPY = {
  start: {
    title: 'FOUNDRY NINE',
    copy: 'Vanguard attacks, Ember defends. Plant the bomb on site A or B — or eliminate the whole Ember team. First to 5 rounds takes the match.',
    action: 'Click to play',
  },
  paused: {
    title: 'FOUNDRY NINE',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  roundEnd: {
    title: 'Round over',
    copy: '',
    action: 'Next round',
  },
  matchEnd: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay');
  const title = $('overlay-title');
  const copy = $('overlay-copy');
  const play = $('play');
  const crosshair = $('crosshair');
  const hitmarker = $('hitmarker');
  const healthValue = $('health-value');
  const armorValue = $('armor-value');
  const armorRow = $('armor-row');
  const ammoMag = $('ammo-mag');
  const ammoReserve = $('ammo-reserve');
  const weaponName = $('weapon-name');
  const grenadeCount = $('grenade-count');
  const moneyValue = $('money-value');
  const timerValue = $('timer-value');
  const scoreVanguard = $('score-vanguard');
  const scoreEmber = $('score-ember');
  const roundValue = $('round-value');
  const aliveVanguard = $('alive-vanguard');
  const aliveEmber = $('alive-ember');
  const killfeed = $('killfeed');
  const banner = $('banner');
  const bombStatus = $('bomb-status');
  const plantBar = $('plant-bar');
  const plantFill = $('plant-fill');
  const buyMenu = $('buy-menu');
  const buyMoney = $('buy-money');
  const buyGrid = $('buy-grid');

  let lastHealth = -1;
  let lastArmor = -1;
  let lastMag = -1;
  let lastReserve = -1;
  let lastMoney = -1;
  let lastTimer = '';
  let lastScoreV = -1;
  let lastScoreE = -1;
  let lastAliveV = '';
  let lastAliveE = '';
  let lastWeapon = '';
  let lastGrenades = -1;
  let lastGap = -1;
  let hitTimer = 0;
  let bannerTimer = 0;

  const buyItems = [
    { id: 'rifle', label: 'VK-47 Carbine', price: WEAPONS.rifle.price, note: '30-round auto rifle' },
    { id: 'smg', label: 'Rook-9 SMG', price: WEAPONS.smg.price, note: 'Fast, close range' },
    { id: 'grenade', label: 'Frag Grenade', price: GRENADE_PRICE, note: 'Throw with G' },
    { id: 'armor', label: 'Kevlar Vest', price: ARMOR_PRICE, note: 'Halves damage taken' },
  ];
  let buyHandler = null;
  let buyCloseHandler = null;

  for (const item of buyItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-item';
    button.dataset.id = item.id;
    button.innerHTML = `<b>${item.label}</b><span>${item.note}</span><em>$${item.price}</em>`;
    button.addEventListener('click', () => { if (buyHandler) buyHandler(item.id); });
    buyGrid.appendChild(button);
  }
  $('buy-close').addEventListener('click', () => { if (buyCloseHandler) buyCloseHandler(); });

  function setBuyAffordability(money, owned) {
    buyMoney.textContent = `$${money}`;
    for (const button of buyGrid.children) {
      const item = buyItems.find((i) => i.id === button.dataset.id);
      const ownedAlready = owned.includes(item.id);
      button.disabled = ownedAlready || money < item.price;
      button.classList.toggle('owned', ownedAlready);
      if (ownedAlready) button.querySelector('em').textContent = 'OWNED';
      else button.querySelector('em').textContent = `$${item.price}`;
    }
  }

  return {
    setHealth(value) {
      const v = Math.max(0, Math.ceil(value));
      if (v === lastHealth) return;
      lastHealth = v;
      healthValue.textContent = String(v);
      healthValue.parentElement.classList.toggle('low', v <= 30);
    },
    setArmor(value) {
      const v = Math.max(0, Math.ceil(value));
      if (v === lastArmor) return;
      lastArmor = v;
      armorValue.textContent = String(v);
      armorRow.style.display = v > 0 ? '' : 'none';
    },
    setAmmo(mag, reserve) {
      if (mag === lastMag && reserve === lastReserve) return;
      lastMag = mag;
      lastReserve = reserve;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      ammoMag.parentElement.classList.toggle('empty', mag === 0);
    },
    setWeapon(id) {
      if (id === lastWeapon) return;
      lastWeapon = id;
      weaponName.textContent = WEAPONS[id].name;
    },
    setGrenades(count) {
      if (count === lastGrenades) return;
      lastGrenades = count;
      grenadeCount.textContent = count > 0 ? `◉ ${count}` : '';
    },
    setMoney(value) {
      if (value === lastMoney) return;
      lastMoney = value;
      moneyValue.textContent = `$${value}`;
    },
    setTimer(seconds, bombSeconds) {
      const text = bombSeconds != null
        ? `💣 ${Math.max(0, Math.ceil(bombSeconds))}`
        : `${Math.max(0, Math.floor(seconds / 60))}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, '0')}`;
      if (text === lastTimer) return;
      lastTimer = text;
      timerValue.textContent = text;
      timerValue.classList.toggle('bomb', bombSeconds != null);
    },
    setScore(vanguard, ember) {
      if (vanguard === lastScoreV && ember === lastScoreE) return;
      lastScoreV = vanguard;
      lastScoreE = ember;
      scoreVanguard.textContent = String(vanguard);
      scoreEmber.textContent = String(ember);
    },
    setRound(round) {
      roundValue.textContent = `ROUND ${round}`;
    },
    setAlive(vanguard, ember) {
      const v = '●'.repeat(vanguard) + '○'.repeat(Math.max(0, 3 - vanguard));
      const e = '●'.repeat(ember) + '○'.repeat(Math.max(0, 4 - ember));
      if (v === lastAliveV && e === lastAliveE) return;
      lastAliveV = v;
      lastAliveE = e;
      aliveVanguard.textContent = v;
      aliveEmber.textContent = e;
    },
    setCrosshairGap(px) {
      const v = Math.round(px);
      if (v === lastGap) return;
      lastGap = v;
      crosshair.style.setProperty('--gap', `${v}px`);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    killfeedLine(text, good) {
      const line = document.createElement('div');
      line.className = good ? 'feed-line good' : 'feed-line';
      line.textContent = text;
      killfeed.prepend(line);
      while (killfeed.children.length > 5) killfeed.removeChild(killfeed.lastChild);
      setTimeout(() => line.classList.add('fade'), 4200);
      setTimeout(() => line.remove(), 5000);
    },
    showBanner(text, holdMs = 2200) {
      banner.textContent = text;
      banner.classList.add('on');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => banner.classList.remove('on'), holdMs);
    },
    setBomb(text) {
      bombStatus.textContent = text;
    },
    setPlant(progress) {
      if (progress == null) {
        plantBar.hidden = true;
        return;
      }
      plantBar.hidden = false;
      plantFill.style.width = `${Math.round(progress * 100)}%`;
    },
    showOverlay(mode, data = {}) {
      const text = COPY[mode];
      title.textContent = text.title;
      if (mode === 'roundEnd') {
        copy.textContent = `${data.reason}. ${data.winner === 'vanguard' ? 'Vanguard takes the round.' : 'Ember takes the round.'} Score ${data.scoreV}–${data.scoreE}.`;
      } else if (mode === 'matchEnd') {
        copy.textContent = `${data.winner === 'vanguard' ? 'Vanguard' : 'Ember'} wins the match ${data.scoreV}–${data.scoreE}.`;
      } else {
        copy.textContent = text.copy;
      }
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    showBuy(money, owned, roundNumber) {
      $('buy-round').textContent = String(roundNumber);
      setBuyAffordability(money, owned);
      buyMenu.hidden = false;
    },
    hideBuy() {
      buyMenu.hidden = true;
    },
    refreshBuy(money, owned) {
      setBuyAffordability(money, owned);
    },
    onBuy(handler) { buyHandler = handler; },
    onBuyClose(handler) { buyCloseHandler = handler; },
  };
}
