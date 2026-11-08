'use strict';
const { composePoster } = require('./compose');
const { mockBackground } = require('./mock-background');
const { fitText, wrapLines, sanitize } = require('./fit-text');
const { TEMPLATES, SIZES, TEMPLATE_IDS } = require('../../templates');

module.exports = { composePoster, mockBackground, fitText, wrapLines, sanitize, TEMPLATES, SIZES, TEMPLATE_IDS };
