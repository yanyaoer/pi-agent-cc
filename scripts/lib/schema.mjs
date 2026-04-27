// schema.mjs — minimal, zero-dependency JSON Schema validator + JSON extraction
//
// Why custom instead of ajv: our three schemas (plan, test-report, eval-report)
// use only `type`, `required`, `properties`, `enum`, `items`, `pattern`,
// `minItems`, `minimum`, `maximum`, `additionalProperties`. A ~100 LOC walker
// covers this cleanly and keeps the plugin dependency-free.
//
// Public API:
//   loadSchema(name) -> schema object
//   validate(data, schema) -> { valid, errors[] }
//   extractLastJsonBlock(text) -> string | null
//   parseAndValidate(text, schemaName) -> { ok, data?, errors? }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '..', '..', 'schemas');

const KNOWN_SCHEMAS = {
  plan: 'plan.schema.json',
  'test-report': 'test-report.schema.json',
  'eval-report': 'eval-report.schema.json',
};

const _cache = new Map();

export function loadSchema(name) {
  const file = KNOWN_SCHEMAS[name];
  if (!file) throw new Error(`Unknown schema: ${name}. Expected one of: ${Object.keys(KNOWN_SCHEMAS).join(', ')}`);
  if (_cache.has(name)) return _cache.get(name);
  const abs = path.join(SCHEMAS_DIR, file);
  const raw = fs.readFileSync(abs, 'utf8');
  const obj = JSON.parse(raw);
  _cache.set(name, obj);
  return obj;
}

/**
 * Minimal JSON Schema (draft-07 subset) validator.
 * Supports: type, required, properties, enum, items, pattern, minItems,
 * minimum, maximum, additionalProperties.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(data, schema) {
  const errors = [];
  _walk(data, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

function _walk(value, schema, pathStr, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => _typeMatches(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join('|')}, got ${_typeOf(value)}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`);
  }

  if (typeof value === 'string') {
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) errors.push(`${pathStr}: string "${value}" does not match pattern /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${pathStr}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${pathStr}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${pathStr}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((el, i) => _walk(el, schema.items, `${pathStr}[${i}]`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${pathStr}: missing required property "${key}"`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) _walk(value[key], propSchema, `${pathStr}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${pathStr}: additional property "${key}" not allowed`);
      }
    }
  }
}

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function _typeMatches(v, t) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

/**
 * Extract the last JSON object appearing in a string.
 * Handles LLM replies that may include prose before the JSON and optional
 * surrounding ```json fences. Scans from the end of the text to find the
 * last balanced `{...}` block.
 *
 * @param {string} text
 * @returns {string | null} the JSON substring, or null if none found
 */
export function extractLastJsonBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Try stripping common ``` fences around a trailing JSON block.
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/i);
  if (fenced) return fenced[1];

  // Walk backwards to find the last '}' and its matching '{' at depth 0,
  // respecting string literals so braces inside strings don't confuse us.
  const lastClose = text.lastIndexOf('}');
  if (lastClose === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = lastClose; i >= 0; i--) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '}') depth++;
    else if (c === '{') {
      depth--;
      if (depth === 0) return text.slice(i, lastClose + 1);
    }
  }
  return null;
}

/**
 * Convenience: extract the last JSON block from `text`, JSON.parse it, and
 * validate it against the named schema.
 *
 * @param {string} text
 * @param {'plan'|'test-report'|'eval-report'} schemaName
 * @returns {{ ok: true, data: any } | { ok: false, errors: string[] }}
 */
export function parseAndValidate(text, schemaName) {
  const block = extractLastJsonBlock(text);
  if (!block) return { ok: false, errors: ['no JSON object found in response'] };
  let data;
  try {
    data = JSON.parse(block);
  } catch (err) {
    return { ok: false, errors: [`JSON.parse failed: ${err.message}`] };
  }
  const schema = loadSchema(schemaName);
  const res = validate(data, schema);
  if (!res.valid) return { ok: false, errors: res.errors };
  return { ok: true, data };
}
