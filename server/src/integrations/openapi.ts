import YAML from 'yaml';
import type { HttpToolParam, IntegrationToolSpec } from '../../../shared/types';

/**
 * Turns a real OpenAPI 3.x (or Swagger 2) definition into Tandem tool drafts.
 * Only the definition's own operation/parameter/schema facts are used —
 * nothing is invented for it.
 */

export interface ParsedOperation {
  name: string;
  description: string;
  spec: IntegrationToolSpec;
  paramsSchema: { properties: Record<string, unknown>; required: string[] };
}

export interface ParsedSpec {
  title: string;
  baseUrl: string | null;
  operations: ParsedOperation[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

export function parseOpenApi(text: string): ParsedSpec {
  let doc: any;
  const trimmed = text.trim();
  if (!trimmed) throw new Error('The specification is empty.');
  try {
    doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : YAML.parse(trimmed);
  } catch (err) {
    throw new Error(`Could not parse the specification as JSON or YAML: ${err instanceof Error ? err.message : err}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    throw new Error('This does not look like an OpenAPI definition — no "paths" object found.');
  }

  const title = String(doc.info?.title ?? 'API');
  const baseUrl = doc.servers?.[0]?.url
    ? String(doc.servers[0].url)
    : doc.host ? `${(doc.schemes?.[0] ?? 'https')}://${doc.host}${doc.basePath ?? ''}` : null;

  const resolveRef = (node: any): any => {
    if (node && typeof node === 'object' && typeof node.$ref === 'string') {
      const parts = node.$ref.replace(/^#\//, '').split('/');
      let cur: any = doc;
      for (const p of parts) cur = cur?.[p];
      return cur ?? {};
    }
    return node;
  };

  const operations: ParsedOperation[] = [];
  for (const [rawPath, pathItemRaw] of Object.entries<any>(doc.paths)) {
    const pathItem = resolveRef(pathItemRaw);
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = (pathItem.parameters ?? []).map(resolveRef);
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const params: HttpToolParam[] = [];
      for (const raw of [...sharedParams, ...(op.parameters ?? []).map(resolveRef)]) {
        if (!raw?.name || !['path', 'query'].includes(raw.in)) continue;
        const schema = resolveRef(raw.schema ?? raw);
        params.push({
          name: String(raw.name),
          type: schema?.type === 'integer' || schema?.type === 'number' ? 'number' : schema?.type === 'boolean' ? 'boolean' : 'string',
          in: raw.in,
          required: !!raw.required || raw.in === 'path',
          description: String(raw.description ?? schema?.description ?? ''),
        });
      }

      // JSON request body: flatten top-level object properties into body params;
      // anything else becomes a single `body` param
      let bodyMode: 'none' | 'json' = 'none';
      const bodySchema = resolveRef(resolveRef(op.requestBody)?.content?.['application/json']?.schema);
      if (bodySchema) {
        bodyMode = 'json';
        if (bodySchema.type === 'object' && bodySchema.properties && typeof bodySchema.properties === 'object') {
          const required = new Set<string>(bodySchema.required ?? []);
          for (const [name, propRaw] of Object.entries<any>(bodySchema.properties)) {
            const prop = resolveRef(propRaw);
            params.push({
              name,
              type: prop?.type === 'integer' || prop?.type === 'number' ? 'number' : prop?.type === 'boolean' ? 'boolean'
                : prop?.type === 'string' ? 'string' : 'json',
              in: 'body',
              required: required.has(name),
              description: String(prop?.description ?? ''),
            });
          }
        } else {
          params.push({ name: 'body', type: 'json', in: 'body', required: !!resolveRef(op.requestBody)?.required, description: 'JSON request body' });
        }
      }

      const name = op.operationId
        ? String(op.operationId)
        : `${method}_${rawPath.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_')}`;
      const description = String(op.summary || op.description || `${method.toUpperCase()} ${rawPath}`).slice(0, 1_000);

      operations.push({
        name,
        description,
        spec: { kind: 'http', method: method.toUpperCase(), path: rawPath, bodyMode, params },
        paramsSchema: paramsToSchema(params),
      });
    }
  }
  if (operations.length === 0) throw new Error('The definition parsed, but contains no operations.');
  return { title, baseUrl, operations };
}

export function paramsToSchema(params: HttpToolParam[]): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = {
      type: p.type === 'json' ? 'object' : p.type,
      ...(p.description ? { description: p.description } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { properties, required };
}
