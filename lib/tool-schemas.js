/**
 * dsh-proxy-pro — tool schema specs (pure data, no imports).
 *
 * These are the author-facing dsh-tools value-schema specs for the three agent
 * tools. They live in their own module for ONE reason: `test/tool-schema.test.mjs`
 * compiles them with the real `@deepseek-ai/dsh-tools` compiler before the app
 * ever boots, so a schema-DSL violation can no longer surface only as a
 * boot-time `plugin tree failed to load` (see docs/LESSONS.md §15).
 *
 * DSL rules enforced by that compiler (dsh-tools lib/schema compiler):
 *  - every `type: 'object'` must declare `additionalProperties` as an explicit
 *    boolean — omitting it throws;
 *  - `required` is a per-PROPERTY marker and may only be present as `true`;
 *    omit it for optional properties (`required: false` is an error);
 *  - only these keys are allowed on a node: description/title/default/examples,
 *    `required` (property nodes only), plus `type`, and per type:
 *    object → properties/additionalProperties, array → items,
 *    scalar → enum/const, or the `oneOf` alternative (never with `type`).
 *
 * @module dsh-proxy-pro/tool-schemas
 */

/** Output schema of `proxy_status` and `proxy_set` (the status snapshot). */
export const PROXY_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    active: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    mode: { type: 'string', required: true },
    url: { type: 'string', required: true },
    noProxy: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    source: { type: 'string', required: true },
    at: { type: 'string', required: true },
  },
}

/** Parameters of `proxy_set`. */
export const PROXY_SET_PARAMETERS = {
  enabled: {
    type: 'boolean',
    required: true,
    description: 'true = route traffic through the configured proxy; false = go direct (no proxy).',
  },
}

/** Parameters of `proxy_test`. */
export const PROXY_TEST_PARAMETERS = {
  url: {
    type: 'string',
    required: true,
    description: 'The URL to diagnose, e.g. https://github.com/foo/bar.',
  },
}

/** Output schema of `proxy_test`. */
export const PROXY_TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    route: { type: 'string', required: true },
    bypassed: { type: 'boolean', required: true },
    probe: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        ok: { type: 'boolean', required: true },
        // Three-state verdict plus the actionable pair the panel and the tool
        // render (2026-09-17: a 504 used to print as "reachable"). Every field
        // must be listed here — the object is additionalProperties:false, so an
        // undeclared field fails schema validation.
        verdict: { type: 'string' },
        status: { type: 'number' },
        kind: { type: 'string' },
        short: { type: 'string' },
        why: { type: 'string' },
        fix: { type: 'string' },
        note: { type: 'string' },
      },
    },
    hint: { type: 'string' },
  },
}

/**
 * Parameters of `proxy_config` — every field optional: call with none to read
 * the configuration, or with any subset to change it. Optional properties must
 * OMIT `required` entirely (`required: false` is a DSL error, see §15).
 */
export const PROXY_CONFIG_PARAMETERS = {
  enabled: {
    type: 'boolean',
    description: 'true = route through the proxy; false = go direct. Omit to leave the switch unchanged.',
  },
  mode: {
    type: 'string',
    enum: ['system', 'custom'],
    description: 'system = follow the Windows system proxy; custom = use customUrl. Omit to leave the mode unchanged.',
  },
  customUrl: {
    type: 'string',
    description: 'Proxy address for mode "custom", e.g. http://127.0.0.1:7890 (bare host:port also accepted). Pass an empty string to clear it.',
  },
  noProxy: {
    type: 'string',
    description: 'Comma-separated hosts/domains that always go DIRECT, e.g. "api.deepseek.com,huggingface.co". Pass an empty string to clear it.',
  },
}
