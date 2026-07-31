import { parse, type Node } from "acorn";
import { assertPortableOutputSchema } from "./output-schema.ts";
import type { WorkflowMeta, WorkflowMetaPhase } from "./types.ts";

type AnyNode = Node & {
  [key: string]: any;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
};

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date APIs and Math.random() (including simple aliases) are unavailable";

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
    ranges: false,
  }) as unknown as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) {
    throw new Error("meta must have a literal value");
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);
  assertStaticWorkflowSchemas(ast);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(
  node: AnyNode,
  path: string,
  resolveIdentifier?: (name: string, path: string) => unknown,
  allowReservedKeys = false,
): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = allowReservedKeys
        ? Object.create(null) as Record<string, unknown>
        : {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (!allowReservedKeys && (key === "__proto__" || key === "constructor" || key === "prototype")) {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`, resolveIdentifier, allowReservedKeys);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`, resolveIdentifier, allowReservedKeys);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    case "Identifier":
      if (resolveIdentifier) return resolveIdentifier(node.name, path);
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function collectTopLevelConstants(ast: AnyNode): Map<string, AnyNode> {
  const constants = new Map<string, AnyNode>();
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declarator of statement.declarations as AnyNode[]) {
      if (declarator.id?.type === "Identifier" && declarator.init) {
        constants.set(declarator.id.name, declarator.init as AnyNode);
      }
    }
  }
  return constants;
}

function resolveStaticObject(node: AnyNode, constants: Map<string, AnyNode>): AnyNode | undefined {
  if (node.type === "ObjectExpression") return node;
  if (node.type !== "Identifier") return undefined;
  const value = constants.get(node.name);
  return value?.type === "ObjectExpression" ? value : undefined;
}

function staticSchemaNode(call: AnyNode, constants: Map<string, AnyNode>): AnyNode | undefined {
  const optionsNode = call.arguments?.[1] as AnyNode | undefined;
  if (!optionsNode) return undefined;
  const options = resolveStaticObject(optionsNode, constants);
  if (!options) return undefined;

  let schemaNode: AnyNode | undefined;
  for (const prop of options.properties as AnyNode[]) {
    if (prop.type !== "Property" || prop.kind !== "init" || prop.method) continue;
    if (propertyNameOfPatternProperty(prop) === "schema") {
      schemaNode = prop.value as AnyNode;
    }
  }
  return schemaNode;
}

function evaluateStaticSchema(node: AnyNode, constants: Map<string, AnyNode>): unknown {
  if (node.type !== "ObjectExpression" && node.type !== "Identifier") {
    throw new Error("schema must be a static object literal or reference a top-level const");
  }
  const resolving = new Set<string>();
  const resolveIdentifier = (name: string, path: string): unknown => {
    const value = constants.get(name);
    if (!value) {
      throw new Error(`${path} must be a static object literal or reference a top-level const`);
    }
    if (resolving.has(name)) {
      throw new Error(`${path} contains a circular const reference: ${name}`);
    }
    resolving.add(name);
    try {
      return evaluateLiteral(value, path, resolveIdentifier, true);
    } finally {
      resolving.delete(name);
    }
  };
  return evaluateLiteral(node, "schema", resolveIdentifier, true);
}

function assertStaticWorkflowSchemas(ast: AnyNode): void {
  const constants = collectTopLevelConstants(ast);
  const visit = (node: AnyNode): void => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "agent") {
      const schemaNode = staticSchemaNode(node, constants);
      if (schemaNode && !(schemaNode.type === "Literal" && schemaNode.value == null)) {
        const location = schemaNode.loc?.start ?? node.loc?.start;
        const where = location ? ` at line ${location.line}, column ${location.column + 1}` : "";
        try {
          assertPortableOutputSchema(evaluateStaticSchema(schemaNode, constants));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Workflow schema preflight failed for agent()${where}: ${message}`);
        }
      }
    }
    for (const child of astChildren(node)) visit(child);
  };
  visit(ast);
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

interface DeterminismScanState {
  mathAliases: Set<string>;
}

function assertDeterministicAst(
  node: AnyNode,
  state: DeterminismScanState = { mathAliases: new Set(["Math"]) },
): void {
  if (isNondeterministicReference(node, state)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
  recordDeterminismAliases(node, state);
  for (const child of astChildren(node)) {
    assertDeterministicAst(child, state);
  }
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      children.push(...value.filter(isAstNode));
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

// Determinism is the only invariant this scan enforces. Resume-by-replay assumes
// a cooperative script reproduces the same agent() calls from the same inputs,
// so references to the two common host sources of nondeterminism are rejected:
// Date APIs (`new Date()`, `Date()`, `Date.now`, members, and simple aliases)
// and `Math.random` (including static/computed member access plus simple object
// aliases and destructuring). This is not a security sandbox; workflows are
// trusted code and clever code can bypass a lint-style AST scan.
function isNondeterministicReference(node: AnyNode, state: DeterminismScanState): boolean {
  if (isStaticMathRandomReference(node, state)) {
    return true;
  }
  if (node.type === "VariableDeclarator" && isMathAliasSource(node.init, state) && patternReadsKey(node.id, "random")) {
    return true;
  }
  if (node.type === "AssignmentExpression" && isMathAliasSource(node.right, state) && patternReadsKey(node.left, "random")) {
    return true;
  }
  if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date") {
    return true;
  }
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date") {
    return true;
  }
  if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "Date") {
    return true;
  }
  if (node.type === "VariableDeclarator" && node.init?.type === "Identifier" && node.init.name === "Date") {
    return true;
  }
  if (node.type === "AssignmentExpression" && node.right?.type === "Identifier" && node.right.name === "Date") {
    return true;
  }
  return false;
}

function recordDeterminismAliases(node: AnyNode, state: DeterminismScanState): void {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isMathAliasSource(node.init, state)) {
    state.mathAliases.add(node.id.name);
  }
  if (node.type === "AssignmentExpression" && node.left?.type === "Identifier" && isMathAliasSource(node.right, state)) {
    state.mathAliases.add(node.left.name);
  }
}

function isStaticMathRandomReference(node: AnyNode, state: DeterminismScanState): boolean {
  return (
    node.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    state.mathAliases.has(node.object.name) &&
    propertyNameOf(node) === "random"
  );
}

function isMathAliasSource(node: AnyNode | undefined, state: DeterminismScanState): boolean {
  return node?.type === "Identifier" && state.mathAliases.has(node.name);
}

function patternReadsKey(node: AnyNode | undefined, key: string): boolean {
  if (node?.type !== "ObjectPattern") {
    return false;
  }
  for (const prop of node.properties as AnyNode[]) {
    if (prop.type === "Property" && propertyNameOfPatternProperty(prop) === key) {
      return true;
    }
  }
  return false;
}

function propertyNameOfPatternProperty(prop: AnyNode): string | undefined {
  if (!prop.computed && prop.key?.type === "Identifier") return prop.key.name;
  return staticStringOf(prop.key);
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}
