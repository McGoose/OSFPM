import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { safeValidatorCompiler } from './validation.js';

/** A value that must never appear in a failing path. */
const SECRET = 'secret-marker-3b8a';

/** What the compiler is given for a route's schema. */
const route = (schema: z.core.$ZodType) => ({
  schema,
  method: 'POST' as const,
  url: '/test',
  httpPart: 'body' as const,
});

/** The `instancePath` of every failure of `data` against `schema`, as the validator reports them. */
function failingPaths(schema: z.core.$ZodType, data: unknown): string[] {
  const result = safeValidatorCompiler(route(schema))(data) as {
    error?: { instancePath: string }[];
  };
  return (result.error ?? []).map((issue) => issue.instancePath);
}

describe('the validator that keeps submitted data out of failing paths', () => {
  it('keeps the names of declared fields and the positions in arrays', () => {
    const schema = z.object({
      title: z.string(),
      nested: z.object({ count: z.number() }),
      list: z.array(z.object({ id: z.string() })),
    });
    expect(
      failingPaths(schema, {
        title: 1,
        nested: { count: 'x' },
        list: [{}, { id: 2 }],
      }).sort(),
    ).toEqual(['/list/0/id', '/list/1/id', '/nested/count', '/title']);
  });

  it('replaces a record key with *, whatever it looks like', () => {
    const schema = z.object({
      attributes: z.record(z.string(), z.object({ amount: z.number() })),
    });
    expect(
      failingPaths(schema, {
        attributes: {
          [SECRET]: { amount: 'x' },
          '07123456789': { amount: 'y' },
          '0': { amount: 'z' },
        },
      }),
    ).toEqual([
      '/attributes/*/amount',
      '/attributes/*/amount',
      '/attributes/*/amount',
    ]);
  });

  it('replaces the key of a record whose key itself is invalid', () => {
    const schema = z.object({
      tags: z.record(z.string().min(100), z.number()),
    });
    const paths = failingPaths(schema, { tags: { [SECRET]: 1 } });
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).not.toContain(SECRET);
  });

  it('replaces a key that only a catchall accepts', () => {
    const schema = z.object({ a: z.string() }).catchall(z.number());
    expect(failingPaths(schema, { a: 'x', [SECRET]: 'not a number' })).toEqual([
      '/*',
    ]);
  });

  it('looks through optional, nullable, default and union wrappers', () => {
    const schema = z.object({
      a: z.object({ b: z.string() }).optional(),
      c: z.object({ d: z.string() }).nullable(),
      e: z.object({ f: z.string() }).default({ f: 'x' }),
      g: z.union([
        z.object({ kind: z.literal('one'), value: z.string() }),
        z.record(z.string(), z.number()),
      ]),
    });
    const paths = failingPaths(schema, {
      a: { b: 1 },
      c: { d: 1 },
      e: { f: 1 },
      g: { kind: 'one', value: 1 },
    });
    expect(paths).toEqual(expect.arrayContaining(['/a/b', '/c/d', '/e/f']));
  });

  it('follows a recursive schema without looping', () => {
    type Node = { name: string; children: Node[] };
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    expect(
      failingPaths(node, {
        name: 'root',
        children: [{ name: 1, children: [] }],
      }),
    ).toEqual(['/children/0/name']);
  });

  it('follows tuples and discriminated unions', () => {
    const schema = z.object({
      pair: z.tuple([z.string(), z.object({ n: z.number() })]),
      shape: z.discriminatedUnion('type', [
        z.object({ type: z.literal('circle'), radius: z.number() }),
        z.object({ type: z.literal('square'), side: z.number() }),
      ]),
    });
    expect(
      failingPaths(schema, {
        pair: ['a', { n: 'x' }],
        shape: { type: 'circle', radius: 'big' },
      }).sort(),
    ).toEqual(['/pair/1/n', '/shape/radius']);
  });

  it('puts nothing a caller sent into a failure that has no field, such as an unknown key', () => {
    const schema = z.strictObject({ a: z.string() });
    const paths = failingPaths(schema, { a: 'x', [SECRET]: 1 });
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).not.toContain(SECRET);
  });

  it('still marks the failures as the type provider does, so the error handler recognises them', () => {
    const result = safeValidatorCompiler(route(z.object({ a: z.string() })))({
      a: 1,
    }) as { error: unknown[] };
    expect(
      hasZodFastifySchemaValidationErrors({ validation: result.error }),
    ).toBe(true);
  });

  it('passes a valid value through unchanged', () => {
    const result = safeValidatorCompiler(route(z.object({ a: z.string() })))({
      a: 'x',
    });
    expect(result).toEqual({ value: { a: 'x' } });
  });
});
