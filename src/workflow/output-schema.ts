const JSON_SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function assertJsonValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite JSON numbers");
    return;
  }
  if (typeof value !== "object") fail(path, "must contain only JSON values");
  if (seen.has(value)) fail(path, "must not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
      return;
    }
    if (!isRecord(value)) fail(path, "must contain only plain JSON objects");
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, appendPath(path, key), seen);
    }
  } finally {
    seen.delete(value);
  }
}

function schemaTypes(schema: Record<string, unknown>, path: string): string[] {
  if (schema.type === undefined) return [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0 || types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))) {
    fail(appendPath(path, "type"), "must be a valid JSON Schema type or non-empty array of types");
  }
  if (new Set(types).size !== types.length) {
    fail(appendPath(path, "type"), "must not contain duplicate types");
  }
  return types as string[];
}

function schemaRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be a schema object");
  return value;
}

function validateSchemaNode(schema: Record<string, unknown>, path: string): void {
  const types = schemaTypes(schema, path);
  const hasObjectShape = types.includes("object") || schema.properties !== undefined;
  if (hasObjectShape) {
    if (!types.includes("object")) {
      fail(appendPath(path, "type"), 'must include "object" when properties are defined');
    }
    if (schema.additionalProperties !== false) {
      fail(appendPath(path, "additionalProperties"), "must be false for every object schema");
    }
    const propertiesPath = appendPath(path, "properties");
    const properties = schemaRecord(schema.properties, propertiesPath);
    const propertyNames = Object.keys(properties);
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
      fail(appendPath(path, "required"), "must be an array containing every property name");
    }
    const required = schema.required as string[];
    if (new Set(required).size !== required.length) {
      fail(appendPath(path, "required"), "must not contain duplicate property names");
    }
    const missing = propertyNames.filter((name) => !required.includes(name));
    if (missing.length > 0) {
      fail(appendPath(path, "required"), `must include every property; missing: ${missing.join(", ")}`);
    }
    const unknown = required.filter((name) => !Object.hasOwn(properties, name));
    if (unknown.length > 0) {
      fail(appendPath(path, "required"), `contains names not present in properties: ${unknown.join(", ")}`);
    }
    for (const [name, child] of Object.entries(properties)) {
      const childPath = appendPath(propertiesPath, name);
      validateSchemaNode(schemaRecord(child, childPath), childPath);
    }
  }

  if (schema.items !== undefined) {
    validateSchemaNode(schemaRecord(schema.items, appendPath(path, "items")), appendPath(path, "items"));
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      fail(appendPath(path, "anyOf"), "must be a non-empty array of schema objects");
    }
    schema.anyOf.forEach((child, index) => {
      const childPath = `${appendPath(path, "anyOf")}[${index}]`;
      validateSchemaNode(schemaRecord(child, childPath), childPath);
    });
  }
  if (schema.$defs !== undefined) {
    const definitions = schemaRecord(schema.$defs, appendPath(path, "$defs"));
    for (const [name, child] of Object.entries(definitions)) {
      const childPath = appendPath(appendPath(path, "$defs"), name);
      validateSchemaNode(schemaRecord(child, childPath), childPath);
    }
  }
}

export function assertPortableOutputSchema(schema: unknown): void {
  assertJsonValue(schema, "$", new WeakSet());
  const root = schemaRecord(schema, "$");
  if (root.type !== "object") {
    fail("$.type", 'root schema must have type "object"');
  }
  validateSchemaNode(root, "$");
}
