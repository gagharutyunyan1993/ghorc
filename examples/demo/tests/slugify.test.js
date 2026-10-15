'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('../src/slugify');

test('lowercases and joins words with a hyphen', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('trims surrounding whitespace', () => {
  assert.equal(slugify('  padded title  '), 'padded-title');
});

test('strips leading and trailing hyphens', () => {
  assert.equal(slugify('--edge--'), 'edge');
});

test('collapses repeated separators into one hyphen', () => {
  assert.equal(slugify('a  b -- c'), 'a-b-c');
});
