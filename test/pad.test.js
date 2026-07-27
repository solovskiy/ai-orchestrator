'use strict';
const assert = require('node:assert');
const { pad } = require('../lib/agent.js');

// Короткая строка паддится пробелами
assert.strictEqual(
  pad('hello', 10),
  'hello     ',
  'short string should be padded with spaces'
);

// Строка длиннее ширины возвращается целиком, не обрезанной
assert.strictEqual(
  pad('hello world', 5),
  'hello world',
  'long string should be returned as-is, not truncated'
);

// Точное совпадение длины — не обрезается
assert.strictEqual(
  pad('hello', 5),
  'hello',
  'exact length should return string unchanged'
);

// null/undefined обрабатываются как пустая строка
assert.strictEqual(
  pad(null, 5),
  '     ',
  'null should be treated as empty string'
);

assert.strictEqual(
  pad(undefined, 5),
  '     ',
  'undefined should be treated as empty string'
);

// Число приводится к строке
assert.strictEqual(
  pad(42, 5),
  '42   ',
  'number should be converted to string'
);

// Пустая строка
assert.strictEqual(
  pad('', 3),
  '   ',
  'empty string should be padded'
);

// Очень длинная строка не обрезается
const longStr = 'a'.repeat(100);
assert.strictEqual(
  pad(longStr, 50),
  longStr,
  'very long string should NOT be truncated'
);

console.log('pad: OK');
