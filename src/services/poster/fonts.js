'use strict';
// Registers the bundled fonts (fonts/*.ttf, SIL OFL) under explicit family names so weight
// selection never depends on system fonts (Render's container has almost none).
const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');
const config = require('../../config');

const FAMILIES = {
  display: 'NZ Display', // Montserrat ExtraBold - headlines
  displayBold: 'NZ Display Bold', // Montserrat Bold
  body: 'NZ Body', // Inter Regular
  bodySemi: 'NZ Body SemiBold', // Inter SemiBold
  bodyBold: 'NZ Body Bold', // Inter Bold
};

const FILES = {
  [FAMILIES.display]: 'Montserrat_800ExtraBold.ttf',
  [FAMILIES.displayBold]: 'Montserrat_700Bold.ttf',
  [FAMILIES.body]: 'Inter_400Regular.ttf',
  [FAMILIES.bodySemi]: 'Inter_600SemiBold.ttf',
  [FAMILIES.bodyBold]: 'Inter_700Bold.ttf',
};

let registered = false;
function registerFonts() {
  if (registered) return FAMILIES;
  for (const [family, file] of Object.entries(FILES)) {
    const ok = GlobalFonts.registerFromPath(path.join(config.root, 'fonts', file), family);
    if (!ok) throw new Error(`could not load font fonts/${file}`);
  }
  registered = true;
  return FAMILIES;
}

const font = (family, size) => `${Math.round(size)}px "${family}"`;

module.exports = { FAMILIES, registerFonts, font };
