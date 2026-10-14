// calcparse.test.js — automated tests for the expression parser/evaluator (calcparse.js).
// Plain Node, no browser shims. Run with: node calcparse.test.js

const assert = require('assert');
const CalcParse = require('./calcparse.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  -', name); passed++; }
  catch (err) { console.log('  FAIL -', name, '\n       ', err.message); failed++; }
}
function evalRad(expr, scope) { return CalcParse.evaluateExpression(expr, scope || {}, 'rad'); }
function evalDeg(expr, scope) { return CalcParse.evaluateExpression(expr, scope || {}, 'deg'); }
function close(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

console.log('Basic arithmetic and precedence');
test('addition', () => assert.strictEqual(evalRad('2+3'), 5));
test('subtraction', () => assert.strictEqual(evalRad('10-4'), 6));
test('multiplication', () => assert.strictEqual(evalRad('3*4'), 12));
test('division', () => assert.strictEqual(evalRad('10/4'), 2.5));
test('multiplication before addition', () => assert.strictEqual(evalRad('2+3*4'), 14));
test('parentheses override precedence', () => assert.strictEqual(evalRad('(2+3)*4'), 20));
test('nested parentheses', () => assert.strictEqual(evalRad('((1+2)*(3+4))'), 21));

console.log('\nExponents (right-associative)');
test('simple power', () => assert.strictEqual(evalRad('2^3'), 8));
test('right-associative: 2^3^2 = 2^(3^2) = 512, not (2^3)^2 = 64', () => assert.strictEqual(evalRad('2^3^2'), 512));

console.log('\nUnary minus');
test('leading unary minus', () => assert.strictEqual(evalRad('-5+3'), -2));
test('unary minus after operator', () => assert.strictEqual(evalRad('3*-2'), -6));
test('unary minus on a parenthesized group', () => assert.strictEqual(evalRad('-(2+3)'), -5));
test('double negative', () => assert.strictEqual(evalRad('--5'), 5));

console.log('\nImplicit multiplication');
test('number times variable: 2x with x=3', () => assert.strictEqual(evalRad('2x', { x: 3 }), 6));
test('number times parenthesized group: 2(3+1)', () => assert.strictEqual(evalRad('2(3+1)'), 8));
test('two parenthesized groups: (2+1)(3+1)', () => assert.strictEqual(evalRad('(2+1)(3+1)'), 12));
test('number times function call: 3sin(0)', () => assert.strictEqual(evalRad('3sin(0)'), 0));
test('a bare number-number sequence is NOT implicit multiplication (should error, not silently be 6)', () => {
  assert.throws(() => evalRad('2 3'));
});
test('coefficient times variable inside a larger expression: 2x+1 with x=5', () => assert.strictEqual(evalRad('2x+1', { x: 5 }), 11));

console.log('\nFunctions');
test('sqrt', () => assert.strictEqual(evalRad('sqrt(16)'), 4));
test('abs of a negative', () => assert.strictEqual(evalRad('abs(-5)'), 5));
test('ln(e) = 1', () => assert.ok(close(evalRad('ln(e)'), 1)));
test('log base 10 of 100 = 2', () => assert.ok(close(evalRad('log(100)'), 2)));

console.log('\nTrig / angle mode');
test('sin(0) in radians = 0', () => assert.ok(close(evalRad('sin(0)'), 0)));
test('sin(pi/2) in radians = 1', () => assert.ok(close(evalRad('sin(pi/2)'), 1)));
test('sin(90) in degrees = 1', () => assert.ok(close(evalDeg('sin(90)'), 1)));
test('cos(180) in degrees = -1', () => assert.ok(close(evalDeg('cos(180)'), -1)));
test('asin(1) in degrees = 90', () => assert.ok(close(evalDeg('asin(1)'), 90)));
test('asin(1) in radians = pi/2', () => assert.ok(close(evalRad('asin(1)'), Math.PI / 2)));

console.log('\nConstants and variables');
test('pi constant', () => assert.ok(close(evalRad('pi'), Math.PI)));
test('e constant', () => assert.ok(close(evalRad('e'), Math.E)));
test('variable substitution: x^2+1 with x=3', () => assert.strictEqual(evalRad('x^2+1', { x: 3 }), 10));
test('undefined variable throws rather than silently returning NaN', () => {
  assert.throws(() => evalRad('x+1', {}));
});

console.log('\nFactorial');
test('5! = 120', () => assert.strictEqual(evalRad('5!'), 120));
test('0! = 1', () => assert.strictEqual(evalRad('0!'), 1));

console.log('\nError handling — malformed input should throw, not silently misparse');
test('trailing operator', () => assert.throws(() => evalRad('2+')));
test('unmatched paren', () => assert.throws(() => evalRad('(2+3')));
test('unknown identifier', () => assert.throws(() => evalRad('foo(2)')));
test('empty input', () => assert.throws(() => evalRad('')));

console.log('\nParse-once, evaluate-many (the pattern graphing actually uses)');
test('same AST evaluated at different x values gives different results', () => {
  const ast = CalcParse.parse('x^2', 'rad');
  assert.strictEqual(CalcParse.evaluate(ast, { x: 2 }, 'rad'), 4);
  assert.strictEqual(CalcParse.evaluate(ast, { x: 3 }, 'rad'), 9);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
