import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { rollDiceExpression, normalizeDiceExpression, splitDiceRounds, MAX_DICE_EXPRESSION_LENGTH, MAX_DICE_EXPRESSION_DEPTH } = await importBilibiliHost('modules/dice/domain/diceExpression.js')
const { DiceManager } = await importBilibiliHost('modules/dice/infrastructure/DiceManager.js')
const limits = Object.freeze({ maxDiceCount: 100, maxDiceSides: 100000 })
const values = [0, 0.16, 0.66, 0.99, 0.5, 0.83]

// Captured from the canonical legacy parser before extraction, including exact detail and random draw counts.
const golden = [
  {"expr": "", "result": {"expr": "1D100", "detail": "1D100[1]", "total": 1}, "draws": 1},
  {"expr": " （２Ｄ６ ＋ ３） × ２ ", "result": {"expr": "(2D6+3)*2", "detail": "2D6[1+1]", "total": 10}, "draws": 2},
  {"expr": "-7/2", "result": {"expr": "-7/2", "detail": "-3", "total": -3}, "draws": 0},
  {"expr": "10 mod 3", "result": {"expr": "10%3", "detail": "1", "total": 1}, "draws": 0},
  {"expr": "2d6+1d4*2", "result": {"expr": "2D6+1D4*2", "detail": "2D6[1+1]+1D4[3]", "total": 8}, "draws": 3},
  {"expr": "(1d6+2)*3", "result": {"expr": "(1D6+2)*3", "detail": "1D6[1]", "total": 9}, "draws": 1},
  {"expr": "4d6kh3", "result": {"expr": "4D6KH3", "detail": "4D6KH3[1+1+4+6=>1+4+6]", "total": 11}, "draws": 4},
  {"expr": "4d6kl2", "result": {"expr": "4D6KL2", "detail": "4D6KL2[1+1+4+6=>1+1]", "total": 2}, "draws": 4},
  {"expr": "4d6dh1", "result": {"expr": "4D6DH1", "detail": "4D6DH1[1+1+4+6=>1+1+4]", "total": 6}, "draws": 4},
  {"expr": "4d6dl2", "result": {"expr": "4D6DL2", "detail": "4D6DL2[1+1+4+6=>4+6]", "total": 10}, "draws": 4},
  {"expr": "4d6min3", "result": {"expr": "4D6MIN3", "detail": "4D6MIN3[1+1+4+6=>3+3+4+6]", "total": 16}, "draws": 4},
  {"expr": "4d6max2", "result": {"expr": "4D6MAX2", "detail": "4D6MAX2[1+1+4+6=>1+1+2+2]", "total": 6}, "draws": 4},
  {"expr": "4d6kh0", "result": {"expr": "4D6KH0", "detail": "4D6KH0[1+1+4+6=>1+1+4+6]", "total": 12}, "draws": 4},
  {"expr": "4d6dh4>=1", "result": {"expr": "4D6DH4>=1", "detail": "4D6DH4[1+1+4+6=>]", "total": "成功 0/1"}, "draws": 4},
  {"expr": "0d6", "result": {"expr": "0D6", "detail": "1D6[1]", "total": 1}, "draws": 1},
  {"expr": "6d6a4", "result": {"expr": "6D6>4", "detail": "6D6[1✗+1✗+4✗+6✓+4✗+5✓]", "total": "成功 2/6"}, "draws": 6},
  {"expr": "d20优势+3", "result": {"expr": "2D20KH1+3", "detail": "2D20KH1[1+4=>4]", "total": 7}, "draws": 2},
  {"expr": "d20劣勢", "result": {"expr": "2D20KL1", "detail": "2D20KL1[1+4=>1]", "total": 1}, "draws": 2},
  {"expr": "f", "result": {"expr": "F", "detail": "4F[--0+]", "total": -1}, "draws": 4},
  {"expr": "3f", "result": {"expr": "3F", "detail": "3F[--0]", "total": -2}, "draws": 3},
  {"expr": "f+1d6>=4", "result": {"expr": "F+1D6>=4", "detail": "4F[--0+]+1D6[4✓]", "total": "成功 1/1"}, "draws": 5},
  {"expr": "1d6+f>=4", "result": {"expr": "1D6+F>=4", "detail": "1D6[1✗]+4F[-0+0]", "total": "成功 0/1"}, "draws": 5},
  {"expr": "10<60", "result": {"expr": "10<60", "detail": "10", "total": "成功 1/1"}, "draws": 0},
  {"expr": "2d6>=4", "result": {"expr": "2D6>=4", "detail": "2D6[1✗+1✗]", "total": "成功 0/2"}, "draws": 2},
  {"expr": "2d6kh>=4", "result": {"expr": "2D6KH>=4", "detail": "2D6KH[1+1=>1✗]", "total": "成功 0/1"}, "draws": 2},
]

for (const { expr, result, draws } of golden) test(`pure and legacy expression preserve captured output: ${expr || '(default)'}`, () => {
  for (const evaluate of [random => rollDiceExpression(expr, limits, random), random => new DiceManager().rollExpression(expr, limits, random)]) {
    let used = 0
    assert.deepEqual(evaluate(() => values[used++ % values.length]), result)
    assert.equal(used, draws)
  }
})

test('normalization retains full-width, arithmetic, mod, advantage and whitespace semantics', () => {
  assert.equal(normalizeDiceExpression(), '1d100')
  assert.equal(normalizeDiceExpression(' （Ｄ２０優勢 ＋ ３） × ２ ÷ ４ ％ ３ '), '(2d20kh1+3)*2/4%3')
  assert.equal(normalizeDiceExpression('3d20优势'), '3d20优势')
  assert.equal(normalizeDiceExpression('2d6kh1'), '2d6kh1')
  assert.equal(normalizeDiceExpression('10 MOD 3'), '10%3')
})

test('pure evaluation uses only injected random and limits without a manager or config', () => {
  const originalRandom = Math.random
  try {
    Math.random = () => { throw Error('unexpected global random') }
    assert.deepEqual(rollDiceExpression('d6+3', { maxDiceCount: 1, maxDiceSides: 6 }, () => 0.5), { expr: 'D6+3', detail: '1D6[4]', total: 7 })
    assert.deepEqual(rollDiceExpression('f', { maxDiceCount: 4, maxDiceSides: 2 }, () => 1), { expr: 'F', detail: '4F[++++]', total: 4 })
    assert.equal(rollDiceExpression('2+3*4-5/2', limits, () => { throw Error('arithmetic must not draw') }).total, 11)
    assert.throws(() => rollDiceExpression('d6', limits), /随机源必须由调用方提供/u)
  } finally { Math.random = originalRandom }
})

test('dice limits cover each group and the combined standard and Fate budget', () => {
  let draws = 0
  const random = () => { draws += 1; return 0 }
  const small = { maxDiceCount: 4, maxDiceSides: 6 }
  for (const [expr, error] of [['5d6', /骰子数量必须是 1-4/u], ['d7', /骰子面数必须是 2-6/u], ['d1', /骰子面数必须是 2-6/u], ['5f', /命运骰数量必须是 1-4/u], ['0f', /命运骰数量必须是 1-4/u]]) {
    assert.throws(() => rollDiceExpression(expr, small, random), error)
  }
  assert.equal(draws, 0)
  assert.throws(() => rollDiceExpression('3d6+2f', small, random), /单次最多掷 4 颗骰子/u)
  assert.equal(draws, 3)
  assert.throws(() => rollDiceExpression('3f+2d6', small, random), /单次最多掷 4 颗骰子/u)
  assert.equal(draws, 6)
})

test('invalid syntax and arithmetic retain legacy errors', () => {
  for (const [expr, error] of [['d', /骰子面数不能为空/u], ['1d100<', /格式不正确/u], ['(1+2', /括号未闭合/u], ['1/0', /不能除以 0/u], ['1%0', /不能对 0 取余/u], ['2**3', /格式不正确/u], ['1.5', /格式不正确/u], ['1e3', /格式不正确/u], ['abc', /格式不正确/u]]) {
    assert.throws(() => rollDiceExpression(expr, limits, () => 0), error)
  }
  assert.throws(() => rollDiceExpression('9'.repeat(400), limits, () => 0), /骰点结果无效/u)
})

test('pure round splitting preserves legacy precedence, trimming and unclamped counts', () => {
  const manager = new DiceManager()
  for (const [text, expected] of [
    ['', { rounds: 1, expr: '' }], ['  d6  ', { rounds: 1, expr: 'd6' }],
    ['3 # d6 + 1', { rounds: 3, expr: 'd6 + 1' }], [' d6 + 1 # 3 ', { rounds: 3, expr: 'd6 + 1' }],
    ['0#d6', { rounds: 1, expr: 'd6' }], ['d6#0002', { rounds: 2, expr: 'd6' }],
    ['1001#d6', { rounds: 1001, expr: 'd6' }], ['3#d6#2', { rounds: 3, expr: 'd6#2' }],
    ['#3', { rounds: 1, expr: '#3' }], ['3#', { rounds: 1, expr: '3#' }],
    ['d6#-2', { rounds: 1, expr: 'd6#-2' }], ['3＃d6', { rounds: 1, expr: '3＃d6' }],
  ]) {
    assert.deepEqual(splitDiceRounds(text), expected)
    assert.deepEqual(manager.splitRounds(text), expected)
  }
})

test('resource guards stop oversized input and recursive stacks before drawing random', () => {
  let draws = 0
  const random = () => { draws += 1; return 0 }
  assert.equal(rollDiceExpression('1' + ' '.repeat(MAX_DICE_EXPRESSION_LENGTH - 1), limits, random).total, 1)
  assert.throws(() => rollDiceExpression('1' + ' '.repeat(MAX_DICE_EXPRESSION_LENGTH), limits, random), /表达式长度不能超过/u)
  for (const expr of ['('.repeat(MAX_DICE_EXPRESSION_DEPTH) + '1' + ')'.repeat(MAX_DICE_EXPRESSION_DEPTH), '-'.repeat(MAX_DICE_EXPRESSION_DEPTH) + '1']) {
    assert.equal(rollDiceExpression(expr, limits, random).total, 1)
  }
  for (const expr of ['('.repeat(MAX_DICE_EXPRESSION_DEPTH + 1) + 'd6' + ')'.repeat(MAX_DICE_EXPRESSION_DEPTH + 1), '-'.repeat(MAX_DICE_EXPRESSION_DEPTH + 1) + 'd6']) {
    assert.throws(() => rollDiceExpression(expr, limits, random), error => error.name === 'Error' && /嵌套层数不能超过/u.test(error.message))
  }
  assert.equal(draws, 0)
})
