'use strict';
const boldTop = require('./bold-top');
const centeredCard = require('./centered-card');

const TEMPLATES = { [boldTop.id]: boldTop, [centeredCard.id]: centeredCard };

const SIZES = {
  square: { W: 1080, H: 1080 },
  portrait: { W: 1080, H: 1350 },
};

module.exports = { TEMPLATES, SIZES, TEMPLATE_IDS: Object.keys(TEMPLATES) };
