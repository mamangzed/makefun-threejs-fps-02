// The round: one state store for the match. Phases: 'buy' (freeze, shop open),
// 'live', 'over' (banner, then the next round), 'match' (someone took the match).
// Money follows the Counter-Strike shape, simplified: kills pay, wins pay more
// than losses, and the buy menu spends it between rounds.
import { WEAPONS, GRENADE_PRICE, ARMOR_PRICE } from './weapons.js';

export const BUY_TIME = 8;
export const ROUND_TIME = 100;
export const BOMB_TIME = 35;
export const ROUNDS_TO_WIN = 5;
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const WIN_REWARD = 3250;
export const LOSS_REWARD = 1900;
export const PLANT_REWARD = 300;

export function createRound() {
  const state = {
    phase: 'buy',
    phaseTime: BUY_TIME,
    round: 1,
    score: { vanguard: 0, ember: 0 },
    money: START_MONEY,
    bomb: { state: 'carried', site: null, timer: 0 },
    winner: null,
    winReason: '',
    matchWinner: null,
    kills: 0,
    deaths: 0,
  };

  function startRound() {
    state.phase = 'buy';
    state.phaseTime = BUY_TIME;
    state.bomb = { state: 'carried', site: null, timer: 0 };
    state.winner = null;
    state.winReason = '';
  }

  function endRound(winner, reason) {
    if (state.phase === 'over' || state.phase === 'match') return false;
    state.phase = 'over';
    state.phaseTime = 3.5;
    state.winner = winner;
    state.winReason = reason;
    state.score[winner] += 1;
    state.money += winner === 'vanguard' ? WIN_REWARD : LOSS_REWARD;
    if (state.score[winner] >= ROUNDS_TO_WIN) {
      state.matchWinner = winner;
    }
    return true;
  }

  function nextRound() {
    if (state.matchWinner) {
      state.phase = 'match';
      return;
    }
    state.round += 1;
    startRound();
  }

  function step(dt) {
    state.phaseTime -= dt;
    if (state.phase === 'buy' && state.phaseTime <= 0) {
      state.phase = 'live';
      state.phaseTime = ROUND_TIME;
    } else if (state.phase === 'live' && state.phaseTime <= 0) {
      // Time out with no plant: the defenders held the sites.
      endRound('ember', 'Time expired — Ember held the sites');
    } else if (state.phase === 'over' && state.phaseTime <= 0) {
      nextRound();
    }
    if (state.bomb.state === 'planted') {
      state.bomb.timer -= dt;
      if (state.bomb.timer <= 0) {
        endRound('vanguard', 'The bomb detonated');
      }
    }
  }

  function plant(site) {
    state.bomb = { state: 'planted', site, timer: BOMB_TIME };
    state.money += PLANT_REWARD;
  }

  function defuse() {
    state.bomb = { state: 'defused', site: null, timer: 0 };
    endRound('ember', 'The bomb was defused');
  }

  function canBuy(id) {
    if (id === 'grenade') return state.money >= GRENADE_PRICE;
    if (id === 'armor') return state.money >= ARMOR_PRICE;
    const def = WEAPONS[id];
    return def && state.money >= def.price;
  }

  function buy(id) {
    if (!canBuy(id)) return false;
    if (id === 'grenade') state.money -= GRENADE_PRICE;
    else if (id === 'armor') state.money -= ARMOR_PRICE;
    else state.money -= WEAPONS[id].price;
    return true;
  }

  return {
    state, step, startRound, endRound, nextRound, plant, defuse, canBuy, buy,
    reset() {
      state.round = 1;
      state.score = { vanguard: 0, ember: 0 };
      state.money = START_MONEY;
      state.matchWinner = null;
      state.kills = 0;
      state.deaths = 0;
      startRound();
    },
  };
}
