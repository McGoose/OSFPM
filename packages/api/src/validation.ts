import type { FastifySchemaCompiler } from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import type { z } from 'zod';

/** A Zod schema's definition, which Zod 4 keeps at `_zod.def`. */
type Definition = { readonly type?: string } & Readonly<
  Record<string, unknown>
>;

function definitionOf(schema: unknown): Definition | undefined {
  return (schema as { _zod?: { def?: Definition } } | null | undefined)?._zod
    ?.def;
}

/** The kinds of schema that wrap another one without changing which fields it has. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'catch',
  'readonly',
  'promise',
]);

/**
 * The schemas a value of `schema` can have, after looking through wrappers,
 * pipes, lazy schemas, unions and intersections.
 */
function resolve(schema: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const definition = definitionOf(schema);
  if (definition === undefined) return [];
  const type = definition.type ?? '';
  if (WRAPPERS.has(type)) return resolve(definition.innerType, seen);
  if (type === 'pipe') return resolve(definition.in, seen);
  if (type === 'lazy') {
    return resolve((definition.getter as () => unknown)(), seen);
  }
  if (type === 'union') {
    return (definition.options as unknown[]).flatMap((option) =>
      resolve(option, seen),
    );
  }
  if (type === 'intersection') {
    return [
      ...resolve(definition.left, seen),
      ...resolve(definition.right, seen),
    ];
  }
  return [schema];
}

/**
 * One step into the schemas `candidates` along `segment`. `safe` says whether
 * the segment is a name or a position the schema itself defines. A record key
 * is data a caller chose, so it is not safe, and neither is a key that only a
 * catchall accepts. `next` holds the schemas the segment leads to.
 */
function step(candidates: unknown[], segment: string) {
  let safe = false;
  const next: unknown[] = [];
  const isIndex = /^\d+$/.test(segment);
  for (const candidate of candidates.flatMap((one) => resolve(one))) {
    const definition = definitionOf(candidate)!;
    switch (definition.type) {
      case 'object': {
        const shape = definition.shape as Record<string, unknown>;
        if (Object.hasOwn(shape, segment)) {
          safe = true;
          next.push(shape[segment]);
        } else if (definition.catchall !== undefined) {
          next.push(definition.catchall);
        }
        break;
      }
      case 'array':
        if (isIndex) {
          safe = true;
          next.push(definition.element);
        }
        break;
      case 'tuple': {
        const items = definition.items as unknown[];
        const index = Number(segment);
        if (isIndex && index < items.length) {
          safe = true;
          next.push(items[index]);
        } else if (isIndex && definition.rest != null) {
          safe = true;
          next.push(definition.rest);
        }
        break;
      }
      case 'record':
      case 'map':
        next.push(definition.valueType);
        break;
    }
  }
  return { safe, next };
}

/**
 * `instancePath` (such as `/list/0/id`) with every segment that the schema does
 * not define replaced by `*`. A segment survives only as a declared object
 * property or an array or tuple position; a record key never does, whatever it
 * looks like. A path that cannot be followed through the schema is `*` from
 * there on, so an unknown case hides data and never shows it.
 */
export function safeInstancePath(
  schema: unknown,
  instancePath: string,
): string {
  if (instancePath === '' || instancePath === '/') return instancePath;
  let candidates: unknown[] = [schema];
  const segments = instancePath
    .slice(1)
    .split('/')
    .map((segment) => {
      const { safe, next } = step(candidates, segment);
      candidates = next;
      return safe ? segment : '*';
    });
  return `/${segments.join('/')}`;
}

/**
 * The type provider's Zod validator, with the path of each failure made safe
 * (see `safeInstancePath`). A failing path is returned to the caller in the
 * problem response, and a `z.record` body would otherwise put the keys the
 * caller chose, which can be personal data, into it (CLAUDE.md, Privacy rule).
 * The failures keep the marker the type provider puts on them, so the error
 * handler still recognises them.
 */
export const safeValidatorCompiler: FastifySchemaCompiler<z.core.$ZodType> = (
  routeSchema,
) => {
  const validate = validatorCompiler(routeSchema);
  return (data) => {
    const result = validate(data);
    const failures =
      typeof result === 'object' && result !== null
        ? (result as { error?: unknown }).error
        : undefined;
    if (!Array.isArray(failures)) return result;
    return {
      error: failures.map(
        (failure: { instancePath: string; keyword: string }) => {
          const instancePath = safeInstancePath(
            routeSchema.schema,
            failure.instancePath,
          );
          return {
            ...failure,
            instancePath,
            schemaPath: `#${instancePath}/${failure.keyword}`,
          };
        },
      ) as unknown as Error,
    };
  };
};
