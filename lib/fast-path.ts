import assert from "assert";
import * as types from "ast-types";
import * as util from "./util";

const n = types.namedTypes;
const isArray = types.builtInTypes.array;
const isNumber = types.builtInTypes.number;

const PRECEDENCE: any = {};
[
  ["??"],
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "===", "!=", "!=="],
  ["<", ">", "<=", ">=", "in", "instanceof"],
  [">>", "<<", ">>>"],
  ["+", "-"],
  ["*", "/", "%"],
  ["**"],
].forEach(function (tier, i) {
  tier.forEach(function (op) {
    PRECEDENCE[op] = i;
  });
});

interface FastPathType {
  stack: any[];
  copy(): any;
  getName(): any;
  getValue(): any;
  valueIsDuplicate(): any;
  getNode(count?: number): any;
  getParentNode(count?: number): any;
  getRootValue(): any;
  call(callback: any, ...names: any[]): any;
  each(callback: any, ...names: any[]): any;
  map(callback: any, ...names: any[]): any;
  hasParens(): any;
  getPrevToken(node: any): any;
  getNextToken(node: any): any;
  needsParens(): any;
  firstInExpressionStatement(): boolean;
  firstInExpressionStatementOrExpressionBody(
    onlyExpressionStatement?: boolean,
  ): boolean;
}

interface FastPathConstructor {
  new (value: any): FastPathType;
  from(obj: any): any;
}

const FastPath = function FastPath(this: FastPathType, value: any) {
  assert.ok(this instanceof FastPath);
  this.stack = [value];
} as any as FastPathConstructor;

const FPp: FastPathType = FastPath.prototype;

// Static convenience function for coercing a value to a FastPath.
FastPath.from = function (obj) {
  if (obj instanceof FastPath) {
    // Return a defensive copy of any existing FastPath instances.
    return obj.copy();
  }

  if (obj instanceof types.NodePath) {
    // For backwards compatibility, unroll NodePath instances into
    // lightweight FastPath [..., name, value] stacks.
    const copy = Object.create(FastPath.prototype);
    const stack = [obj.value];
    for (let pp; (pp = obj.parentPath); obj = pp)
      stack.push(obj.name, pp.value);
    copy.stack = stack.reverse();
    return copy;
  }

  // Otherwise use obj as the value of the new FastPath instance.
  return new FastPath(obj);
};

FPp.copy = function copy() {
  const copy = Object.create(FastPath.prototype);
  copy.stack = this.stack.slice(0);
  return copy;
};

// The name of the current property is always the penultimate element of
// this.stack, and always a String.
FPp.getName = function getName() {
  const s = this.stack;
  const len = s.length;
  if (len > 1) {
    return s[len - 2];
  }
  // Since the name is always a string, null is a safe sentinel value to
  // return if we do not know the name of the (root) value.
  return null;
};

// The value of the current property is always the final element of
// this.stack.
FPp.getValue = function getValue() {
  const s = this.stack;
  return s[s.length - 1];
};

FPp.valueIsDuplicate = function () {
  const s = this.stack;
  const valueIndex = s.length - 1;
  return s.lastIndexOf(s[valueIndex], valueIndex - 1) >= 0;
};

function getNodeHelper(path: any, count: number) {
  const s = path.stack;

  for (let i = s.length - 1; i >= 0; i -= 2) {
    const value = s[i];
    if (n.Node.check(value) && --count < 0) {
      return value;
    }
  }

  return null;
}

FPp.getNode = function getNode(count = 0) {
  return getNodeHelper(this, ~~count);
};

FPp.getParentNode = function getParentNode(count = 0) {
  return getNodeHelper(this, ~~count + 1);
};

// The length of the stack can be either even or odd, depending on whether
// or not we have a name for the root value. The difference between the
// index of the root value and the index of the final value is always
// even, though, which allows us to return the root value in constant time
// (i.e. without iterating backwards through the stack).
FPp.getRootValue = function getRootValue() {
  const s = this.stack;
  if (s.length % 2 === 0) {
    return s[1];
  }
  return s[0];
};

// Temporarily push properties named by string arguments given after the
// callback function onto this.stack, then call the callback with a
// reference to this (modified) FastPath object. Note that the stack will
// be restored to its original state after the callback is finished, so it
// is probably a mistake to retain a reference to the path.
FPp.call = function call(callback /*, name1, name2, ... */) {
  const s = this.stack;
  const origLen = s.length;
  let value = s[origLen - 1];
  const argc = arguments.length;
  for (let i = 1; i < argc; ++i) {
    const name = arguments[i];
    value = value[name];
    s.push(name, value);
  }
  const result = callback(this);
  s.length = origLen;
  return result;
};

// Similar to FastPath.prototype.call, except that the value obtained by
// accessing this.getValue()[name1][name2]... should be array-like. The
// callback will be called with a reference to this path object for each
// element of the array.
FPp.each = function each(callback /*, name1, name2, ... */) {
  const s = this.stack;
  const origLen = s.length;
  let value = s[origLen - 1];
  const argc = arguments.length;

  for (let i = 1; i < argc; ++i) {
    const name = arguments[i];
    value = value[name];
    s.push(name, value);
  }

  for (let i = 0; i < value.length; ++i) {
    if (i in value) {
      s.push(i, value[i]);
      // If the callback needs to know the value of i, call
      // path.getName(), assuming path is the parameter name.
      callback(this);
      s.length -= 2;
    }
  }

  s.length = origLen;
};

// Similar to FastPath.prototype.each, except that the results of the
// callback function invocations are stored in an array and returned at
// the end of the iteration.
FPp.map = function map(callback /*, name1, name2, ... */) {
  const s = this.stack;
  const origLen = s.length;
  let value = s[origLen - 1];
  const argc = arguments.length;

  for (let i = 1; i < argc; ++i) {
    const name = arguments[i];
    value = value[name];
    s.push(name, value);
  }

  const result = new Array(value.length);

  for (let i = 0; i < value.length; ++i) {
    if (i in value) {
      s.push(i, value[i]);
      result[i] = callback(this, i);
      s.length -= 2;
    }
  }

  s.length = origLen;

  return result;
};

// Returns true if the node at the tip of the path is preceded by an
// open-paren token `(`.
FPp.hasParens = function () {
  const node = this.getNode();
  const prevToken = this.getPrevToken(node);
  return prevToken && prevToken.value === "(";
};

FPp.getPrevToken = function (node) {
  node = node || this.getNode();
  const loc = node && node.loc;
  const tokens = loc && loc.tokens;
  if (tokens && loc.start.token > 0) {
    const token = tokens[loc.start.token - 1];
    if (token) {
      // Do not return tokens that fall outside the root subtree.
      const rootLoc = this.getRootValue().loc;
      if (util.comparePos(rootLoc.start, token.loc.start) <= 0) {
        return token;
      }
    }
  }
  return null;
};

FPp.getNextToken = function (node) {
  node = node || this.getNode();
  const loc = node && node.loc;
  const tokens = loc && loc.tokens;
  if (tokens && loc.end.token < tokens.length) {
    const token = tokens[loc.end.token];
    if (token) {
      // Do not return tokens that fall outside the root subtree.
      const rootLoc = this.getRootValue().loc;
      if (util.comparePos(token.loc.end, rootLoc.end) <= 0) {
        return token;
      }
    }
  }
  return null;
};

// Inspired by require("ast-types").NodePath.prototype.needsParens, but
// more efficient because we're iterating backwards through a stack.
FPp.needsParens = function () {
  const node = this.getNode();

  // If the value of this path is some child of a Node and not a Node
  // itself, then it doesn't need parentheses. Only Node objects
  // need parentheses.
  if (this.getValue() !== node) {
    return false;
  }

  // This needs to come before `if (!parent) { return false }` because
  // an object destructuring assignment requires parens for
  // correctness even when it's the topmost expression.
  if (
    node.type === "AssignmentExpression" &&
    node.left.type === "ObjectPattern"
  ) {
    return true;
  }

  const parent = this.getParentNode();

  const name = this.getName();

  // Statements don't need parentheses.
  if (n.Statement.check(node)) {
    return false;
  }

  // Identifiers never need parentheses.
  if (node.type === "Identifier") {
    return false;
  }

  if (parent && parent.type === "ParenthesizedExpression") {
    return false;
  }

  if (node.extra && node.extra.parenthesized) {
    return true;
  }

  if (!parent) return false;

  switch (node.type) {
    case "UnaryExpression":
    case "SpreadElement":
    case "SpreadProperty":
      return parent.type === "MemberExpression" && name === "object";

    case "BinaryExpression":
    case "LogicalExpression":
      switch (parent.type) {
        case "CallExpression":
          return name === "callee";

        case "UnaryExpression":
        case "SpreadElement":
        case "SpreadProperty":
          return true;

        case "MemberExpression":
          return name === "object";

        case "BinaryExpression":
        case "LogicalExpression": {
          const po = parent.operator;
          const pp = PRECEDENCE[po];
          const no = node.operator;
          const np = PRECEDENCE[no];

          if (pp > np) {
            return true;
          }

          if (pp === np && name === "right") {
            return true;
          }

          break;
        }

        default:
          return false;
      }

      break;

    case "SequenceExpression":
      switch (parent.type) {
        case "ReturnStatement":
          return false;

        case "ForStatement":
          // Although parentheses wouldn't hurt around sequence expressions in
          // the head of for loops, traditional style dictates that e.g. i++,
          // j++ should not be wrapped with parentheses.
          return false;

        case "ExpressionStatement":
          return name !== "expression";

        default:
          // Otherwise err on the side of overparenthesization, adding
          // explicit exceptions above if this proves overzealous.
          return true;
      }

    case "Literal":
      return (
        parent.type === "MemberExpression" &&
        isNumber.check(node.value) &&
        name === "object"
      );

    // Babel 6 Literal split
    case "NumericLiteral":
      return parent.type === "MemberExpression" && name === "object";

    case "YieldExpression":
    case "AwaitExpression":
    case "AssignmentExpression":
    case "ConditionalExpression":
      switch (parent.type) {
        case "UnaryExpression":
        case "SpreadElement":
        case "SpreadProperty":
        case "BinaryExpression":
        case "LogicalExpression":
          return true;

        case "CallExpression":
        case "NewExpression":
          return name === "callee";

        case "ConditionalExpression":
          return name === "test";

        case "MemberExpression":
          return name === "object";

        default:
          return false;
      }

    case "ArrowFunctionExpression":
      if (n.CallExpression.check(parent) && name === "callee") {
        return true;
      }

      if (n.MemberExpression.check(parent) && name === "object") {
        return true;
      }

      if (
        n.TSAsExpression &&
        n.TSAsExpression.check(parent) &&
        name === "expression"
      ) {
        return true;
      }

      return isBinary(parent);

    case "ObjectExpression":
      if (parent.type === "ArrowFunctionExpression" && name === "body") {
        return true;
      }

      break;

    case "TSAsExpression":
      if (
        parent.type === "ArrowFunctionExpression" &&
        name === "body" &&
        node.expression.type === "ObjectExpression"
      ) {
        return true;
      }
      break;

    case "CallExpression":
      if (
        name === "declaration" &&
        n.ExportDefaultDeclaration.check(parent) &&
        n.FunctionExpression.check(node.callee)
      ) {
        return true;
      }
      break;

    // Flow type nodes.
    //
    // (TS type nodes don't need any logic here, because they represent
    // parentheses explicitly in the AST, with TSParenthesizedType.)

    case "OptionalIndexedAccessType":
      switch (parent.type) {
        case "IndexedAccessType":
          // `(O?.['x'])['y']` is distinct from `O?.['x']['y']`.
          return name === "objectType";
        default:
          return false;
      }

    case "IndexedAccessType":
    case "ArrayTypeAnnotation":
      return false;

    case "NullableTypeAnnotation":
      switch (parent.type) {
        case "OptionalIndexedAccessType":
        case "IndexedAccessType":
          return name === "objectType";
        case "ArrayTypeAnnotation":
          return true;
        default:
          return false;
      }

    case "IntersectionTypeAnnotation":
      switch (parent.type) {
        case "OptionalIndexedAccessType":
        case "IndexedAccessType":
          return name === "objectType";
        case "ArrayTypeAnnotation":
        case "NullableTypeAnnotation":
          return true;
        default:
          return false;
      }

    case "UnionTypeAnnotation":
      switch (parent.type) {
        case "OptionalIndexedAccessType":
        case "IndexedAccessType":
          return name === "objectType";
        case "ArrayTypeAnnotation":
        case "NullableTypeAnnotation":
        case "IntersectionTypeAnnotation":
          return true;
        default:
          return false;
      }

    case "FunctionTypeAnnotation":
      switch (parent.type) {
        case "OptionalIndexedAccessType":
        case "IndexedAccessType":
          return name === "objectType";

        case "ArrayTypeAnnotation":
        // We need parens.

        // fallthrough
        case "NullableTypeAnnotation":
        // We don't *need* any parens here… unless some ancestor
        // means we do, by putting a `&` or `|` on the right.
        // Just use parens; probably more readable that way anyway.
        // (FWIW, this agrees with Prettier's behavior.)

        // fallthrough
        case "IntersectionTypeAnnotation":
        case "UnionTypeAnnotation":
          // We need parens if there's another `&` or `|` after this node.
          // For consistency, just always use parens.
          // (FWIW, this agrees with Prettier's behavior.)
          return true;

        default:
          return false;
      }
  }

  if (parent.type === "NewExpression" && name === "callee") {
    return containsCallExpression(node);
  }

  // The ExpressionStatement production, and the two productions that
  // contain ExpressionBody, have lookahead constraints that forbid some
  // possibilities for their next node or two:
  //   https://tc39.es/ecma262/#prod-ExpressionStatement
  //   https://tc39.es/ecma262/#prod-ConciseBody
  //   https://tc39.es/ecma262/#prod-AsyncConciseBody
  //
  // The effect of these is that if we have an expression that appears in
  // one of those and would start with a forbidden token sequence, we need
  // to insert parens so that the first token is `(` instead.
  //
  // We choose to do this on the smallest subexpression we can.
  switch (node.type) {
    case "ObjectExpression":
      // Will start with `{`.  Therefore can't be the start of an
      // ExpressionStatement or (either use of) an ExpressionBody.
      return this.firstInExpressionStatementOrExpressionBody();

    case "FunctionExpression":
    case "ClassExpression":
      // Will start with the token `function`, tokens `async function`, or
      // token `class`.  Therefore can't start an ExpressionStatement.
      return this.firstInExpressionStatement();

    case "MemberExpression":
      if (
        n.Identifier.check(node.object) &&
        node.object.name === "let" &&
        node.computed
      ) {
        // Will start with the tokens `let [`.  Therefore can't start an
        // ExpressionStatement.
        return this.firstInExpressionStatement();
      }
      return false;

    default:
      // Will not start with any of the above sequences of tokens, unless it
      // starts with a child node that does.  If so, that child will take
      // care of it (possibly by letting its own child take care of it, etc.)
      return false;
  }
};

function isBinary(node: any) {
  return n.BinaryExpression.check(node) || n.LogicalExpression.check(node);
}

// @ts-ignore 'isUnaryLike' is declared but its value is never read. [6133]
function isUnaryLike(node: any) {
  return (
    n.UnaryExpression.check(node) ||
    // I considered making SpreadElement and SpreadProperty subtypes of
    // UnaryExpression, but they're not really Expression nodes.
    (n.SpreadElement && n.SpreadElement.check(node)) ||
    (n.SpreadProperty && n.SpreadProperty.check(node))
  );
}

function containsCallExpression(node: any): any {
  if (n.CallExpression.check(node)) {
    return true;
  }

  if (isArray.check(node)) {
    return node.some(containsCallExpression);
  }

  if (n.Node.check(node)) {
    return types.someField(node, (_name: any, child: any) =>
      containsCallExpression(child),
    );
  }

  return false;
}

FPp.firstInExpressionStatement = function () {
  return this.firstInExpressionStatementOrExpressionBody(true);
};

FPp.firstInExpressionStatementOrExpressionBody = function (
  onlyExpressionStatement: boolean = false,
) {
  const s = this.stack;
  let parentName, parent;
  let childName, child;

  for (let i = s.length - 1; i >= 0; i -= 2) {
    if (!n.Node.check(s[i])) {
      continue;
    }

    childName = parentName;
    child = parent;
    parentName = s[i - 1];
    parent = s[i];
    if (!parent || !child) {
      continue;
    }

    if (n.ExpressionStatement.check(parent) && childName === "expression") {
      assert.strictEqual(parent.expression, child);
      return true;
    }

    if (n.ArrowFunctionExpression.check(parent) && childName === "body") {
      assert.strictEqual(parent.body, child);
      return !onlyExpressionStatement;
    }

    if (n.AssignmentExpression.check(parent) && childName === "left") {
      assert.strictEqual(parent.left, child);
      continue;
    }

    // s[i + 1] and s[i + 2] represent the array between the parent
    // SequenceExpression node and its child nodes
    if (
      n.SequenceExpression.check(parent) &&
      s[i + 1] === "expressions" &&
      childName === 0
    ) {
      assert.strictEqual(parent.expressions[0], child);
      continue;
    }

    if (n.CallExpression.check(parent) && childName === "callee") {
      assert.strictEqual(parent.callee, child);
      continue;
    }

    if (n.MemberExpression.check(parent) && childName === "object") {
      assert.strictEqual(parent.object, child);
      continue;
    }

    if (n.ConditionalExpression.check(parent) && childName === "test") {
      assert.strictEqual(parent.test, child);
      continue;
    }

    if (isBinary(parent) && childName === "left") {
      assert.strictEqual(parent.left, child);
      continue;
    }

    if (
      n.UnaryExpression.check(parent) &&
      !parent.prefix &&
      childName === "argument"
    ) {
      assert.strictEqual(parent.argument, child);
      continue;
    }

    return false;
  }

  return true;
};

export default FastPath;
