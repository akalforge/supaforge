import { describe, it, expect } from 'vitest'
import { orderForExecution, selectedBackend, type AnalyzeFn } from '../src/ordering'

const STMTS = [
  `CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();`,
  `CREATE TABLE t (id int PRIMARY KEY, m mood);`,
  `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
  `CREATE TYPE mood AS ENUM ('ok','bad');`,
]
const nameOf = (s: string) =>
  (s.match(/CREATE (?:TABLE|TYPE|TRIGGER|FUNCTION)\s+"?(\w+)/) ?? [, '?'])[1]

describe('selectedBackend', () => {
  it('defaults to the built-in sorter', () => {
    expect(selectedBackend({} as NodeJS.ProcessEnv)).toBe('builtin')
  })

  it('opts in via SUPAFORGE_ORDERING', () => {
    expect(selectedBackend({ SUPAFORGE_ORDERING: 'pg-topo' } as NodeJS.ProcessEnv)).toBe('pg-topo')
  })
})

describe('orderForExecution', () => {
  it('orders dependencies before dependents with the built-in sorter', async () => {
    const r = await orderForExecution(STMTS, s => s, 'builtin')
    expect(r.ordered.map(nameOf)).toEqual(['mood', 't', 'f', 'tg'])
    expect(r.backend).toBe('builtin')
  })

  it('uses pg-topo when it returns a faithful permutation', async () => {
    const analyze: AnalyzeFn = async (stmts) => ({
      ordered: [...stmts].reverse(), diagnostics: [],
    })
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)
    expect(r.backend).toBe('pg-topo')
    expect(r.ordered.map(nameOf)).toEqual(['mood', 'f', 't', 'tg'])
  })

  // The safety properties matter more than the ordering itself: pg-topo is
  // alpha, and a wrong order is recoverable where a lost statement is not.
  it('falls back rather than dropping a statement pg-topo could not parse', async () => {
    const analyze: AnalyzeFn = async (stmts) => ({ ordered: stmts.slice(1), diagnostics: [] })
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)

    expect(r.backend).toBe('builtin')
    expect(r.fellBackBecause).toMatch(/returned 3 of 4/)
    expect(r.ordered).toHaveLength(STMTS.length)
  })

  it('falls back when pg-topo reports a parse error', async () => {
    // Parse failures come back as diagnostics, not exceptions — a statement it
    // could not read simply would not appear in the output.
    const analyze: AnalyzeFn = async (stmts) => ({
      ordered: stmts,
      diagnostics: [{ code: 'PARSE_ERROR', message: 'syntax error' }],
    })
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)
    expect(r.backend).toBe('builtin')
    expect(r.fellBackBecause).toMatch(/could not parse 1 statement/)
  })

  it('falls back when pg-topo invents a statement', async () => {
    const analyze: AnalyzeFn = async (stmts) => ({
      ordered: [...stmts.slice(1), 'DROP TABLE something_else;'], diagnostics: [],
    })
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)
    expect(r.backend).toBe('builtin')
    expect(r.fellBackBecause).toMatch(/not in the input/)
  })

  it('falls back when pg-topo throws', async () => {
    const analyze: AnalyzeFn = async () => { throw new Error('boom') }
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)
    expect(r.backend).toBe('builtin')
    expect(r.fellBackBecause).toMatch(/boom/)
  })

  it('keeps duplicate statements rather than collapsing them', async () => {
    const dupes = ['CREATE TABLE a (id int);', 'CREATE TABLE a (id int);']
    const analyze: AnalyzeFn = async (stmts) => ({ ordered: stmts, diagnostics: [] })
    const r = await orderForExecution(dupes, s => s, 'pg-topo', analyze)
    expect(r.ordered).toHaveLength(2)
  })

  it('tolerates whitespace differences in what pg-topo returns', async () => {
    const analyze: AnalyzeFn = async (stmts) =>
      ({ ordered: stmts.map(s => `  ${s.replace(/\s+/g, '  ')}  `), diagnostics: [] })
    const r = await orderForExecution(STMTS, s => s, 'pg-topo', analyze)
    expect(r.backend).toBe('pg-topo')
    expect(r.ordered).toHaveLength(STMTS.length)
  })
})
