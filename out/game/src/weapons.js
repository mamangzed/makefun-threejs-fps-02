// Weapons: the numbers and the view model. Three guns, one grenade.
// Spread grows with movement and with sustained fire, so stopping to aim pays;
// recoil kicks the aim up a little with every shot and recovers while you hold fire.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', price: 0, mag: 12, reserve: 36,
    damage: 26, headDamage: 78, fireGap: 0.16, reloadTime: 1.4, auto: false,
    spreadStill: 0.002, spreadMove: 0.02, spreadBloom: 0.004, recoil: 0.006,
    range: 60, tracer: 0xffd27a,
  },
  rifle: {
    id: 'rifle', name: 'VK-47 Carbine', price: 2700, mag: 30, reserve: 90,
    damage: 30, headDamage: 100, fireGap: 0.096, reloadTime: 1.9, auto: true,
    spreadStill: 0.0022, spreadMove: 0.028, spreadBloom: 0.0035, recoil: 0.009,
    range: 90, tracer: 0xffb347,
  },
  smg: {
    id: 'smg', name: 'Rook-9 SMG', price: 1500, mag: 32, reserve: 96,
    damage: 22, headDamage: 66, fireGap: 0.07, reloadTime: 1.6, auto: true,
    spreadStill: 0.004, spreadMove: 0.034, spreadBloom: 0.003, recoil: 0.005,
    range: 45, tracer: 0xffe08a,
  },
};

export const GRENADE_PRICE = 300;
export const ARMOR_PRICE = 650;
export const ARMOR_REDUCTION = 0.5;

const MUZZLE_TIME = 0.06;

export function createViewModel(camera) {
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.canvas), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.5, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.6, metalness: 0.3 });

  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.4), grip);
  barrel.position.set(0, 0.025, -0.38);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
  stock.position.set(0, -0.02, 0.3);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.06), dark);
  sight.position.set(0, 0.075, -0.1);
  model.add(receiver, barrel, stock, sight);
  model.position.set(0.24, -0.2, -0.42);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.88);
  flash.visible = false;
  camera.add(flash);
  const flashCross = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.035),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  );
  flashCross.position.set(0.24, -0.18, -0.88);
  flashCross.visible = false;
  camera.add(flashCross);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  return { model, flash, flashCross, flashLight };
}

// One gun instance: ammo state, cooldown, bloom, reload. The shooter (player or bot)
// owns the ray; this only owns the numbers and the view model.
export function createGun(camera, defId) {
  let def = WEAPONS[defId];
  const view = createViewModel(camera);
  const state = {
    defId, mag: def.mag, reserve: def.reserve,
    cooldown: 0, reloadLeft: 0, flash: 0, kick: 0, bloom: 0,
  };

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.bloom = Math.max(0, state.bloom - dt * 0.03);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    view.model.position.z = -0.42 + state.kick;
    view.model.rotation.x = state.kick * 2.2;
    view.flash.visible = state.flash > 0;
    view.flash.rotation.z = state.flash * 8;
    view.flashCross.visible = state.flash > 0;
    view.flashCross.rotation.z = state.flash * 8 + 0.6;
    view.flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      view.model.rotation.x = -0.55 * Math.min(1, (def.reloadTime - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = def.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    get def() { return def; },
    view,
    step,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = def.fireGap;
      state.flash = MUZZLE_TIME;
      state.kick = 0.055;
      state.bloom = Math.min(0.05, state.bloom + def.spreadBloom);
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag === def.mag || state.reserve === 0) return;
      state.reloadLeft = def.reloadTime;
    },
    spread(speed, moveReference = 5.2) {
      const def2 = def;
      return def2.spreadStill + Math.min(1, speed / moveReference) * def2.spreadMove + state.bloom;
    },
    refill() {
      state.mag = def.mag;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
    },
    swap(nextId) {
      def = WEAPONS[nextId];
      state.defId = nextId;
      state.mag = def.mag;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.bloom = 0;
    },
  };
}
