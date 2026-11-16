// The look plan, in one place: a dusk foundry — cold steel, warm ember accent.
// The same names are the CSS custom properties in index.html. Team colours live here too:
// Vanguard (the player's team) is signal blue, Ember (the defenders) is furnace red.
export const PALETTE = {
  canvas: '#1a2027',
  surface: '#262c33',
  steel: '#454f59',
  floor: '#2c3138',
  ink: '#ece7db',
  muted: '#8b949c',
  accent: '#ff7a1a',
  vanguard: '#4db2ff',
  ember: '#ff5340',
  site: '#ffc53d',
};

export function paletteColor(name) {
  return PALETTE[name];
}
