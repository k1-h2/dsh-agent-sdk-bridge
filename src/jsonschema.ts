/**
 * Convert dsh `ToolSchema.parameters` (a JSON Schema object) into a zod raw
 * shape for the SDK's in-process MCP `tool()` registration. Fidelity is
 * one-directional on purpose: anything the converter does not recognize maps
 * to `z.unknown()`, and objects stay loose (zod strips unknown keys instead
 * of rejecting them), so a converted tool never rejects arguments the host
 * tool would have accepted. Unmapped PROPERTY NAMES still appear in the shape
 * (as `z.unknown()`), so nothing the model sends is silently stripped.
 * @module dsh-llm-qoder/jsonschema
 */

import { z } from 'zod'

type JsonSchema = Record<string, unknown>

/** A zod raw shape: property name → property schema. */
export type ZodShape = Record<string, z.ZodType>

/**
 * Convert one JSON Schema node into one zod schema.
 * @param schema - a JSON Schema node (object form expected).
 * @param depth - recursion guard; past the cap every node becomes `z.unknown()`.
 * @returns a zod schema covering the recognized constructs.
 */
export function jsonSchemaToZod(schema: JsonSchema | undefined, depth = 0): z.ZodType {
  if (schema === undefined || depth > 6) return z.unknown()
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string')
    if (values.length === schema.enum.length && values.length > 0) return z.enum(values as [string, ...string[]])
    return z.unknown()
  }
  const type = schema.type
  const description = typeof schema.description === 'string' ? schema.description : undefined
  let base: z.ZodType
  switch (type) {
    case 'string': base = z.string(); break
    case 'number': base = z.number(); break
    case 'integer': base = z.number().int(); break
    case 'boolean': base = z.boolean(); break
    case 'array': {
      const items = schema.items
      base = z.array(
        jsonSchemaToZod(typeof items === 'object' && items !== null && !Array.isArray(items) ? items as JsonSchema : undefined, depth + 1),
      )
      break
    }
    case 'object': {
      const properties = schema.properties
      const required = Array.isArray(schema.required) ? schema.required.filter(v => typeof v === 'string') as string[] : []
      const shape: ZodShape = {}
      if (typeof properties === 'object' && properties !== null) {
        for (const [key, node] of Object.entries(properties as Record<string, unknown>)) {
          const nodeSchema = typeof node === 'object' && node !== null && !Array.isArray(node) ? node as JsonSchema : undefined
          shape[key] = required.includes(key)
            ? jsonSchemaToZod(nodeSchema, depth + 1)
            : jsonSchemaToZod(nodeSchema, depth + 1).optional()
        }
      }
      base = z.object(shape)
      break
    }
    default: base = z.unknown()
  }
  return description === undefined ? base : base.describe(description)
}

/**
 * Convert a tool's `parameters` JSON Schema into a zod raw shape for `tool()`.
 * A non-object schema yields a single catch-all shape so registration stays valid.
 * @param parameters - the JSON Schema object from a dsh `ToolSchema`.
 * @returns the zod raw shape handed to the SDK MCP `tool()`.
 */
export function jsonSchemaToShape(parameters: Record<string, unknown>): ZodShape {
  const properties = parameters.properties
  if (typeof properties !== 'object' || properties === null) return {}
  const shape: ZodShape = {}
  const required = Array.isArray(parameters.required) ? parameters.required.filter(v => typeof v === 'string') as string[] : []
  for (const [key, node] of Object.entries(properties as Record<string, unknown>)) {
    const nodeSchema = typeof node === 'object' && node !== null && !Array.isArray(node) ? node as JsonSchema : undefined
    shape[key] = required.includes(key)
      ? jsonSchemaToZod(nodeSchema, 1)
      : jsonSchemaToZod(nodeSchema, 1).optional()
  }
  return shape
}
