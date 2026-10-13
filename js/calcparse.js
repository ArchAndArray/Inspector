// calcparse.js — a pure, DOM-free mathematical expression parser and evaluator for the
// Graphing Calculator tool. No eval() anywhere: user-typed expressions are tokenized and
// parsed into an AST by hand, the same "pure function, framework-free, Node-testable"
// discipline already used for pmdate.js/pmschedule.js/pmcalendar.js — this file has zero
// dependency on the DOM or any other part of the app, and can be required directly under
// plain Node for its own test suite.
//
// Supports: + - * / ^ (right-associative), unary minus, parentheses, implicit multiplication
// (2x, 2(x+1), 3sin(x)), functions (sin cos tan asin acos atan sinh cosh tanh sqrt log ln abs
// exp), constants (pi, e), and a single free variable (x) for graphing — evaluate() takes an
// optional scope object mapping variable names to values.

function calcTokenize(input) {
  const tokens = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => /[a-zA-Z]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      let start = i;
      while (i < input.length && (isDigit(input[i]) || input[i] === '.')) i++;
      tokens.push({ type: 'num', value: parseFloat(input.slice(start, i)) });
      continue;
    }
    if (isAlpha(c)) {
      let start = i;
      while (i < input.length && isAlpha(input[i])) i++;
      tokens.push({ type: 'ident', value: input.slice(start, i) });
      continue;
    }
    if ('+-*/^(),!'.includes(c)) { tokens.push({ type: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

const CALC_FUNCTIONS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  log: Math.log10, ln: Math.log
};
const CALC_CONSTANTS = { pi: Math.PI, e: Math.E };

// Recursive-descent parser producing a plain-object AST. Kept separate from evaluation
// (calcEvaluate) so a graph can parse an expression once and evaluate it many times (once
// per pixel column) without re-parsing on every point.
function calcParse(input, angleMode) {
  const tokens = calcTokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type) => {
    if (!peek() || peek().type !== type) throw new Error(`Expected "${type}"`);
    return tokens[pos++];
  };

  // A token that could legally START a new factor without an explicit operator first —
  // this is what makes "2x", "2(x+1)", "3sin(x)" work as implicit multiplication.
  // Deliberately NOT true for a bare number: "2 3" is far more likely a typo than an
  // intentional "2*3" — real calculator notation never implies multiplication between two
  // plain numbers, only between a number/paren and a variable, function, or paren.
  function startsFactor() {
    const t = peek();
    if (!t) return false;
    return t.type === 'ident' || t.type === '(';
  }

  function parseExpression() {
    let node = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = eat(peek().type).type;
      node = { type: 'binop', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseUnary();
    while (peek() && (peek().type === '*' || peek().type === '/' || startsFactor())) {
      let op = '*';
      if (peek().type === '*' || peek().type === '/') op = eat(peek().type).type;
      node = { type: 'binop', op, left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    if (peek() && (peek().type === '-' || peek().type === '+')) {
      const op = eat(peek().type).type;
      return { type: 'unary', op, arg: parseUnary() };
    }
    return parsePower();
  }

  // Right-associative: 2^3^2 = 2^(3^2), the standard convention.
  function parsePower() {
    const base = parsePostfix();
    if (peek() && peek().type === '^') {
      eat('^');
      return { type: 'binop', op: '^', left: base, right: parseUnary() };
    }
    return base;
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (peek() && peek().type === '!') {
      eat('!');
      node = { type: 'factorial', arg: node };
    }
    return node;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') { eat('num'); return { type: 'num', value: t.value }; }
    if (t.type === '(') {
      eat('(');
      const node = parseExpression();
      eat(')');
      return node;
    }
    if (t.type === 'ident') {
      eat('ident');
      const name = t.value.toLowerCase();
      if (peek() && peek().type === '(' && CALC_FUNCTIONS[name]) {
        eat('(');
        const arg = parseExpression();
        eat(')');
        return { type: 'call', name, arg };
      }
      if (CALC_CONSTANTS[name] != null) return { type: 'const', name };
      if (name === 'x' || name === 'ans') return { type: 'var', name };
      throw new Error(`Unknown name "${t.value}"`);
    }
    throw new Error(`Unexpected token`);
  }

  const ast = parseExpression();
  if (pos < tokens.length) throw new Error('Unexpected trailing input');
  return ast;
}

function calcFactorial(n) {
  if (n < 0 || !Number.isFinite(n) || Math.floor(n) !== n) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// angleMode: 'deg' | 'rad' — applied only to the trig functions' input (and their inverse
// functions' output), matching how a physical scientific calculator's mode switch behaves.
function calcEvaluate(ast, scope, angleMode) {
  scope = scope || {};
  const toRad = (v) => (angleMode === 'deg' ? (v * Math.PI) / 180 : v);
  const fromRad = (v) => (angleMode === 'deg' ? (v * 180) / Math.PI : v);

  function ev(node) {
    switch (node.type) {
      case 'num': return node.value;
      case 'const': return CALC_CONSTANTS[node.name];
      case 'var':
        if (!(node.name in scope)) throw new Error(`"${node.name}" is not defined`);
        return scope[node.name];
      case 'unary': {
        const v = ev(node.arg);
        return node.op === '-' ? -v : v;
      }
      case 'factorial': return calcFactorial(ev(node.arg));
      case 'binop': {
        const l = ev(node.left), r = ev(node.right);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') return l / r;
        if (node.op === '^') return Math.pow(l, r);
        throw new Error(`Unknown operator "${node.op}"`);
      }
      case 'call': {
        const argVal = ev(node.arg);
        const isInverseTrig = node.name === 'asin' || node.name === 'acos' || node.name === 'atan';
        const isTrig = node.name === 'sin' || node.name === 'cos' || node.name === 'tan';
        const input = isTrig ? toRad(argVal) : argVal;
        const result = CALC_FUNCTIONS[node.name](input);
        return isInverseTrig ? fromRad(result) : result;
      }
      default: throw new Error(`Unknown node type "${node.type}"`);
    }
  }
  return ev(ast);
}

// Convenience one-shot for the calculator's own display (parses and evaluates in one call);
// graphing parses once via calcParse and calls calcEvaluate directly per point instead.
function calcEvaluateExpression(input, scope, angleMode) {
  return calcEvaluate(calcParse(input, angleMode), scope, angleMode);
}

const CalcParse = { tokenize: calcTokenize, parse: calcParse, evaluate: calcEvaluate, evaluateExpression: calcEvaluateExpression, FUNCTIONS: CALC_FUNCTIONS, CONSTANTS: CALC_CONSTANTS };

if (typeof window !== 'undefined') window.CalcParse = CalcParse;
if (typeof module !== 'undefined' && module.exports) module.exports = CalcParse;
