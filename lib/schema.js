// Schémas d'outils JSON Schema → sous-ensemble OpenAPI que Gemini accepte dans functionDeclarations.
// Gemini refuse (400) les types multiples, les items en tuple, $ref, const, additionalProperties, les formats inconnus
// et les champs posés sur un schéma d'un autre type (« field predicate failed: $type == … »).

const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);
const SCHEMA_KEYS = new Set(['items', 'additionalProperties', 'not', 'anyOf', 'oneOf', 'allOf']);
// Champs que Gemini n'accepte que sur un schéma du type correspondant
const KEYS_OF = {
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
  object: ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
  string: ['minLength', 'maxLength', 'pattern', 'format'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
};
KEYS_OF.integer = KEYS_OF.number;
const FORMATS = { STRING: ['enum', 'date-time'], NUMBER: ['float', 'double'], INTEGER: ['int32', 'int64'] };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Remplace les $ref locaux (#/$defs/X, #/definitions/X) par leur définition, sans boucler sur une référence récursive. */
function inlineRefs(schema, defs, seen = new Set()) {
  if (Array.isArray(schema)) return schema.map((s) => inlineRefs(s, defs, seen));
  if (!isObject(schema)) return schema;
  if (typeof schema.$ref === 'string') {
    const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(schema.$ref)?.[1];
    const { $ref, ...rest } = schema;
    if (!name || !defs[name] || seen.has(name)) return { type: 'object', ...rest }; // récursion ou référence externe : objet libre
    return inlineRefs({ ...defs[name], ...rest }, defs, new Set([...seen, name]));
  }
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, inlineRefs(v, defs, seen)]));
}

/** allOf fusionné en un seul schéma (propriétés et champs requis réunis). */
function mergeAllOf(schema) {
  if (!isObject(schema)) return schema;
  let out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k,
    SCHEMA_MAPS.has(k) && isObject(v) ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, mergeAllOf(s)]))
      : SCHEMA_KEYS.has(k) ? (Array.isArray(v) ? v.map(mergeAllOf) : mergeAllOf(v)) : v]));
  if (Array.isArray(out.allOf)) {
    const { allOf, ...rest } = out;
    out = allOf.reduce((acc, part) => ({
      ...acc, ...part, ...rest,
      properties: { ...acc.properties, ...part.properties, ...rest.properties },
      required: [...new Set([...(acc.required ?? []), ...(part.required ?? []), ...(rest.required ?? [])])],
    }), {});
    if (!Object.keys(out.properties).length) delete out.properties;
    if (!out.required.length) delete out.required;
  }
  return out;
}

/** Types multiples et tuples → anyOf, chaque branche avec ses propres champs ; type déduit quand il manque. */
export function toUnions(schema) {
  if (!isObject(schema)) return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key,
    SCHEMA_MAPS.has(key) && isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toUnions(v)]))
      : key === 'items' && Array.isArray(value) ? { anyOf: value.map(toUnions) }
        : SCHEMA_KEYS.has(key) ? (Array.isArray(value) ? value.map(toUnions) : toUnions(value))
          : value]));
  if (out.type === undefined && !out.anyOf && !out.oneOf && !out.allOf) {
    if (out.items) out.type = 'array';
    else if (out.properties) out.type = 'object';
  }
  const types = Array.isArray(out.type) && out.type.every((t) => typeof t === 'string') ? out.type.filter((t) => t !== 'null') : [];
  if (Array.isArray(out.type) && types.length === 1) return { ...out, type: types[0], ...(out.type.includes('null') ? { nullable: true } : {}) };
  if (types.length < 2) return out;
  const { type, ...rest } = out;
  const branches = types.map((t) => {
    const branch = { type: t };
    for (const key of KEYS_OF[t] ?? []) if (key in rest) branch[key] = rest[key];
    return branch;
  });
  for (const key of types.flatMap((t) => KEYS_OF[t] ?? [])) delete rest[key];
  return { ...rest, anyOf: branches, ...(type.includes('null') ? { nullable: true } : {}) };
}

/** Un schéma (déjà sans $ref ni allOf ni types multiples) dans le vocabulaire de Gemini. */
function convert(schema) {
  if (!isObject(schema)) return { type: 'STRING' };
  const type = typeof schema.type === 'string' ? schema.type.toUpperCase() : undefined;
  const out = {};
  const hints = [];
  if (type && type !== 'NULL') out.type = type;
  if (type === 'NULL') out.nullable = true;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (typeof schema.title === 'string') out.title = schema.title;
  if (schema.nullable === true) out.nullable = true;
  if (schema.default !== undefined) out.default = schema.default;
  if ('const' in schema) {
    if (typeof schema.const === 'string') { out.enum = [schema.const]; out.type ??= 'STRING'; } else hints.push(`Must be ${JSON.stringify(schema.const)}.`);
  }
  if (Array.isArray(schema.enum)) {
    // Gemini n'accepte que des enum de chaînes
    if (schema.enum.every((v) => typeof v === 'string')) { out.enum = schema.enum; out.type ??= 'STRING'; } else hints.push(`One of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`);
  }
  if (typeof schema.format === 'string') {
    if ((FORMATS[out.type] ?? []).includes(schema.format)) out.format = schema.format; else hints.push(`Format: ${schema.format}.`);
  }
  for (const key of ['minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minimum', 'maximum']) {
    if (schema[key] !== undefined && (KEYS_OF[(schema.type ?? '').toString()] ?? Object.values(KEYS_OF).flat()).includes(key)) out[key] = schema[key];
  }
  if (typeof schema.exclusiveMinimum === 'number') { if (out.type === 'INTEGER') out.minimum = Math.floor(schema.exclusiveMinimum) + 1; else hints.push(`Greater than ${schema.exclusiveMinimum}.`); }
  if (typeof schema.exclusiveMaximum === 'number') { if (out.type === 'INTEGER') out.maximum = Math.ceil(schema.exclusiveMaximum) - 1; else hints.push(`Less than ${schema.exclusiveMaximum}.`); }
  if (out.type === 'ARRAY') out.items = convert(isObject(schema.items) ? schema.items : { type: 'string' });
  if (out.type === 'OBJECT' && isObject(schema.properties)) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, convert(v)]));
    const required = (schema.required ?? []).filter((k) => k in out.properties);
    if (required.length) out.required = required;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const branches = union.filter((b) => !(isObject(b) && b.type === 'null'));
    if (branches.length < union.length) out.nullable = true;
    if (branches.length === 1) Object.assign(out, convert(branches[0]), out.description ? { description: out.description } : {});
    else if (branches.length > 1) out.anyOf = branches.map(convert);
  }
  if (hints.length) out.description = [out.description, ...hints].filter(Boolean).join(' ');
  return out;
}

/** Paramètres d'un outil pour functionDeclarations ; undefined quand l'outil n'en prend aucun. */
export function toGeminiParameters(parameters) {
  if (!isObject(parameters)) return undefined;
  const defs = { ...parameters.definitions, ...parameters.$defs };
  const schema = convert(toUnions(mergeAllOf(inlineRefs(parameters, defs))));
  if (schema.type === 'OBJECT' && !Object.keys(schema.properties ?? {}).length) return undefined;
  return schema;
}

/**
 * Paramètres d'un outil pour Claude via Antigravity : le JSON Schema tel quel (draft 2020-12, ce que Claude attend),
 * dans parametersJsonSchema. La conversion de Google vers Claude casse les anyOf du format Gemini (400 « JSON schema is invalid »).
 */
export function toClaudeParameters(parameters) {
  if (!isObject(parameters)) return undefined;
  const { $schema, $id, ...rest } = parameters;
  // formes antérieures à 2020-12 que Claude refuse : items en tuple (→ anyOf), $ref vers definitions (→ définition copiée)
  const defs = { ...rest.definitions, ...rest.$defs };
  const { definitions, $defs, ...schema } = toUnions(inlineRefs(rest, defs));
  return { type: 'object', properties: {}, ...schema };
}
