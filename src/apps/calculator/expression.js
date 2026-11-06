/**
 * @file Safe arithmetic expression evaluation for Calculator.
 *
 * Expressions are tokenized and evaluated by a small recursive-descent
 * parser — never with `eval()` or `Function()` — so input can only ever
 * produce numbers or a CalcError with a user-facing message.
 *
 * Grammar (highest precedence last):
 *
 *   expression := additive
 *   additive   := term (("+" | "−") term)*            "a + b%" means a + a·b/100
 *   term       := unary (("×" | "÷" | "mod") unary | implicit unary)*
 *   unary      := ("−" | "+") unary | power
 *   power      := postfix (("^" | "E") unary)?        right-associative; −2^2 = −4
 *   postfix    := primary ("!" | "%")*
 *   primary    := number | constant | "Ans" | function "(" expression ")" | "(" expression ")"
 *
 * Implicit multiplication covers "2π", "3(4+1)", "(1+2)(3+4)", and
 * "2sin(30)". Unclosed parentheses are closed automatically at the end
 * of the expression, as on a hand-held calculator.
 *
 * Accepted spellings: × or *, ÷ or /, − or -, π or pi, √ or sqrt,
 * "E" for "×10^" (scientific notation), and lower-case e for Euler's
 * number.
 */

/** An evaluation error whose message is safe to show the user. */
export class CalcError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "CalcError";
  }
}

const FUNCTIONS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "cbrt", "ln", "log", "abs", "exp"]);
const MAX_FACTORIAL = 170;
/** Results this close to an integer or zero are snapped, hiding binary floating-point noise. */
const SNAP_EPSILON = 1e-12;
/** Significant digits kept when displaying a result. */
const DISPLAY_PRECISION = 15;

/**
 * @typedef {object} EvaluateOptions
 * @property {"deg"|"rad"} [angleUnit]
 * @property {number|null} [ans] - Value of "Ans" (the previous result).
 */

/**
 * Evaluate an expression string.
 * @param {string} source
 * @param {EvaluateOptions} [options]
 * @returns {number}
 * @throws {CalcError}
 */
export function evaluate(source, options = {}) {
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new CalcError("Enter an expression");
  const parser = new Parser(tokens, { angleUnit: options.angleUnit ?? "deg", ans: options.ans ?? null });
  const value = parser.parseExpression();
  parser.expectEnd();
  return finalize(value);
}

/**
 * Format a result for display: up to 15 significant digits (enough to
 * keep integers exact up to 10^15 while hiding binary floating-point
 * noise such as 0.1 + 0.2 = 0.30000000000000004), trailing
 * zeros removed, and exponent notation only for very large or very
 * small magnitudes.
 * @param {number} value
 * @returns {string}
 */
export function formatResult(value) {
  if (Object.is(value, -0) || value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-9) {
    const [mantissa, exponent] = value.toExponential(DISPLAY_PRECISION - 1).split("e");
    return `${trimZeros(mantissa)}e${exponent.startsWith("+") ? exponent.slice(1) : exponent}`;
  }
  return trimZeros(Number.parseFloat(value.toPrecision(DISPLAY_PRECISION)).toString());
}

// ---------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------

/**
 * @typedef {{type: "number", value: number} | {type: "op", value: string} | {type: "func", value: string} |
 *   {type: "const", value: string} | {type: "lparen"} | {type: "rparen"}} Token
 */

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  const tokens = [];
  const text = source.replace(/\s+/g, "");
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < text.length && /[0-9.]/.test(text[end])) end += 1;
      const literal = text.slice(index, end);
      if ((literal.match(/\./g) ?? []).length > 1 || literal === ".") {
        throw new CalcError(`"${literal}" is not a valid number`);
      }
      tokens.push({ type: "number", value: Number.parseFloat(literal) });
      index = end;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const operator = { "+": "+", "-": "\u2212", "\u2212": "\u2212", "*": "\u00d7", "\u00d7": "\u00d7", "\u00b7": "\u00d7", "/": "\u00f7", "\u00f7": "\u00f7", "^": "^", "!": "!", "%": "%", E: "E" }[char];
    if (operator) {
      tokens.push({ type: "op", value: operator });
      index += 1;
      continue;
    }

    if (char === "\u03c0") {
      tokens.push({ type: "const", value: "pi" });
      index += 1;
      continue;
    }
    if (char === "\u221a") {
      tokens.push({ type: "func", value: "sqrt" });
      index += 1;
      continue;
    }
    if (char === "\u221b") {
      tokens.push({ type: "func", value: "cbrt" });
      index += 1;
      continue;
    }

    if (/[a-zA-Z]/.test(char)) {
      let end = index;
      while (end < text.length && /[a-zA-Z]/.test(text[end]) && text[end] !== "E") end += 1;
      const word = text.slice(index, end);
      const lower = word.toLowerCase();
      if (lower === "ans") {
        tokens.push({ type: "const", value: "ans" });
      } else if (lower === "pi") {
        tokens.push({ type: "const", value: "pi" });
      } else if (word === "e") {
        tokens.push({ type: "const", value: "e" });
      } else if (lower === "mod") {
        tokens.push({ type: "op", value: "mod" });
      } else if (FUNCTIONS.has(lower)) {
        tokens.push({ type: "func", value: lower });
      } else {
        throw new CalcError(`Unknown name "${word}"`);
      }
      index = end;
      continue;
    }

    throw new CalcError(`Unexpected "${char}"`);
  }

  return tokens;
}

// ---------------------------------------------------------------
// Parser / evaluator
// ---------------------------------------------------------------

class Parser {
  /**
   * @param {Token[]} tokens
   * @param {{angleUnit: "deg"|"rad", ans: number|null}} context
   */
  constructor(tokens, context) {
    this.tokens = tokens;
    this.position = 0;
    this.context = context;
  }

  /** @returns {Token|undefined} */
  peek() {
    return this.tokens[this.position];
  }

  /** @returns {Token|undefined} */
  next() {
    return this.tokens[this.position++];
  }

  /**
   * @param {string} value
   * @returns {boolean}
   */
  isOp(value) {
    const token = this.peek();
    return token?.type === "op" && token.value === value;
  }

  /** @returns {void} */
  expectEnd() {
    const token = this.peek();
    if (!token) return;
    if (token.type === "rparen") throw new CalcError("Unmatched closing parenthesis");
    throw new CalcError("Unexpected input after the expression");
  }

  /** @returns {number} */
  parseExpression() {
    let left = this.parseTerm();
    while (this.isOp("+") || this.isOp("\u2212")) {
      const operator = this.next().value;
      const right = this.parseTermWithPercent();
      // "a + b%" adds b percent of a, as on a hand-held calculator.
      const rightValue = right.percent ? (left * right.value) / 100 : right.value;
      left = operator === "+" ? left + rightValue : left - rightValue;
      assertFinite(left);
    }
    return left;
  }

  /**
   * A term whose final postfix was "%" reports it, so additive
   * expressions can apply percentage-of-left semantics.
   * @returns {{value: number, percent: boolean}}
   */
  parseTermWithPercent() {
    const start = this.position;
    const value = this.parseTerm();
    const consumed = this.tokens.slice(start, this.position);
    const last = consumed.at(-1);
    let percent = last?.type === "op" && last.value === "%";
    // Only a plain "operand%" term qualifies: any other top-level
    // operator (×, ÷, ^, …) means the % belongs to a sub-expression.
    let depth = 0;
    for (const token of consumed.slice(0, -1)) {
      if (token.type === "lparen" || token.type === "func") depth += token.type === "lparen" ? 1 : 0;
      else if (token.type === "rparen") depth -= 1;
      else if (depth === 0 && token.type === "op" && token.value !== "%" && token.value !== "!") percent = false;
    }
    // parseTerm already divided by 100 for "%"; undo that for the additive rule.
    return percent ? { value: value * 100, percent: true } : { value, percent: false };
  }

  /** @returns {number} */
  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("\u00d7")) {
        this.next();
        left *= this.parseUnary();
      } else if (this.isOp("\u00f7")) {
        this.next();
        const divisor = this.parseUnary();
        if (divisor === 0) throw new CalcError("Cannot divide by zero");
        left /= divisor;
      } else if (this.isOp("mod")) {
        this.next();
        const divisor = this.parseUnary();
        if (divisor === 0) throw new CalcError("Cannot divide by zero");
        left = ((left % divisor) + divisor) % divisor;
      } else if (this.startsOperand()) {
        // Implicit multiplication: 2π, 3(4), (1)(2), 2sin(30)
        left *= this.parseUnary();
      } else {
        break;
      }
      assertFinite(left);
    }
    return left;
  }

  /** @returns {boolean} */
  startsOperand() {
    const token = this.peek();
    return Boolean(token) && (token.type === "number" || token.type === "const" || token.type === "func" || token.type === "lparen");
  }

  /** @returns {number} */
  parseUnary() {
    if (this.isOp("\u2212")) {
      this.next();
      return -this.parseUnary();
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  /** @returns {number} */
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp("^")) {
      this.next();
      const exponent = this.parseUnary();
      if (base === 0 && exponent < 0) throw new CalcError("Cannot divide by zero");
      if (base < 0 && !Number.isInteger(exponent)) {
        throw new CalcError("A negative number can't be raised to a fractional power");
      }
      return assertFinite(Math.pow(base, exponent));
    }
    if (this.isOp("E")) {
      this.next();
      const exponent = this.parseUnary();
      return assertFinite(base * Math.pow(10, exponent));
    }
    return base;
  }

  /** @returns {number} */
  parsePostfix() {
    let value = this.parsePrimary();
    for (;;) {
      if (this.isOp("!")) {
        this.next();
        value = factorial(value);
      } else if (this.isOp("%")) {
        this.next();
        value /= 100;
      } else {
        return value;
      }
    }
  }

  /** @returns {number} */
  parsePrimary() {
    const token = this.next();
    if (!token) throw new CalcError("The expression is incomplete");

    switch (token.type) {
      case "number":
        return token.value;
      case "const":
        if (token.value === "pi") return Math.PI;
        if (token.value === "e") return Math.E;
        if (this.context.ans === null) throw new CalcError("There is no previous answer yet");
        return this.context.ans;
      case "lparen":
        return this.parseGroup();
      case "func": {
        if (this.peek()?.type !== "lparen") {
          // "√9" without parentheses applies to the next operand.
          return applyFunction(token.value, this.parsePostfix(), this.context.angleUnit);
        }
        this.next();
        return applyFunction(token.value, this.parseGroup(), this.context.angleUnit);
      }
      case "rparen":
        throw new CalcError("Unexpected closing parenthesis");
      default:
        throw new CalcError(`"${token.value}" needs a number before it`);
    }
  }

  /**
   * Parse after "(" up to and including ")". A missing ")" at the very
   * end of input is tolerated.
   * @returns {number}
   */
  parseGroup() {
    if (this.peek()?.type === "rparen") throw new CalcError("Empty parentheses");
    const value = this.parseExpression();
    const closing = this.peek();
    if (closing?.type === "rparen") {
      this.next();
    } else if (closing) {
      throw new CalcError("Missing closing parenthesis");
    }
    return value;
  }
}

/**
 * @param {string} name
 * @param {number} x
 * @param {"deg"|"rad"} angleUnit
 * @returns {number}
 */
function applyFunction(name, x, angleUnit) {
  const toRadians = (value) => (angleUnit === "deg" ? (value * Math.PI) / 180 : value);
  const fromRadians = (value) => (angleUnit === "deg" ? (value * 180) / Math.PI : value);

  switch (name) {
    case "sin":
      return snap(Math.sin(toRadians(x)));
    case "cos":
      return snap(Math.cos(toRadians(x)));
    case "tan": {
      const radians = toRadians(x);
      if (Math.abs(Math.cos(radians)) < SNAP_EPSILON) throw new CalcError("tan is undefined at this angle");
      return snap(Math.tan(radians));
    }
    case "asin":
      if (x < -1 || x > 1) throw new CalcError("sin\u207b\u00b9 needs a value between \u22121 and 1");
      return snap(fromRadians(Math.asin(x)));
    case "acos":
      if (x < -1 || x > 1) throw new CalcError("cos\u207b\u00b9 needs a value between \u22121 and 1");
      return snap(fromRadians(Math.acos(x)));
    case "atan":
      return snap(fromRadians(Math.atan(x)));
    case "sqrt":
      if (x < 0) throw new CalcError("Square root of a negative number is not a real number");
      return Math.sqrt(x);
    case "cbrt":
      return Math.cbrt(x);
    case "ln":
      if (x <= 0) throw new CalcError("ln needs a value greater than 0");
      return Math.log(x);
    case "log":
      if (x <= 0) throw new CalcError("log needs a value greater than 0");
      return Math.log10(x);
    case "abs":
      return Math.abs(x);
    case "exp":
      return assertFinite(Math.exp(x));
    default:
      throw new CalcError(`Unknown function "${name}"`);
  }
}

/**
 * @param {number} n
 * @returns {number}
 */
function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError("Factorial needs a whole number of 0 or more");
  if (n > MAX_FACTORIAL) throw new CalcError(`Factorial is limited to ${MAX_FACTORIAL}! (larger results are too big to represent)`);
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

/**
 * @param {number} value
 * @returns {number}
 */
function assertFinite(value) {
  if (Number.isNaN(value)) throw new CalcError("The result is not a number");
  if (!Number.isFinite(value)) throw new CalcError("The result is too large to display");
  return value;
}

/**
 * Remove floating-point noise around integers and zero (sin(π) → 0).
 * @param {number} value
 * @returns {number}
 */
function snap(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < SNAP_EPSILON ? rounded : value;
}

/**
 * @param {number} value
 * @returns {number}
 */
function finalize(value) {
  assertFinite(value);
  return Object.is(value, -0) ? 0 : value;
}

/**
 * @param {string} text
 * @returns {string}
 */
function trimZeros(text) {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
