import { describe, it, expect } from 'vitest'
import { parseMultipart, inventoryFunctionsViaStudio } from '../src/edge-functions-api'

const BOUNDARY = '----FormBoundaryabc123'
const CT = `multipart/form-data; boundary=${BOUNDARY}`

/** A body shaped exactly like the one self-hosted Studio returns. */
function body(files: Array<{ name: string; content: string }>): string {
  const parts = [
    `--${BOUNDARY}\r\n`
    + 'Content-Disposition: form-data; name="metadata"\r\n'
    + 'Content-Type: application/json\r\n\r\n'
    + '{"deployment_id":"random-each-deploy","original_size":1}\r\n',
  ]
  for (const f of files) {
    parts.push(
      `--${BOUNDARY}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${f.name}"; filename*=UTF-8''${f.name}\r\n`
      + 'Content-Type: text/plain\r\n\r\n'
      + `${f.content}\r\n`,
    )
  }
  return parts.join('') + `--${BOUNDARY}--\r\n`
}

describe('parseMultipart', () => {
  it('extracts file parts and ignores the metadata part', () => {
    // metadata carries a deployment_id regenerated on every deploy — including
    // it would report drift between two byte-identical functions.
    const files = parseMultipart(CT, body([{ name: 'index.ts', content: 'export default 1' }]))
    expect(files).toEqual([{ name: 'index.ts', body: 'export default 1' }])
  })

  it('handles the extended filename* parameter Studio emits', () => {
    // Response.formData() rejects this body outright ("Failed to parse body as
    // FormData") despite it being well formed, which is why this is parsed by
    // hand rather than trusting a particular undici build.
    const files = parseMultipart(CT, body([{ name: 'a.ts', content: 'x' }]))
    expect(files[0].name).toBe('a.ts')
  })

  it('handles multiple modules', () => {
    const files = parseMultipart(CT, body([
      { name: 'index.ts', content: 'a' },
      { name: 'lib.ts', content: 'b' },
    ]))
    expect(files.map(f => f.name)).toEqual(['index.ts', 'lib.ts'])
  })

  it('preserves content containing the boundary-like text', () => {
    const files = parseMultipart(CT, body([{ name: 'index.ts', content: 'const s = "--not-a-boundary"' }]))
    expect(files[0].body).toBe('const s = "--not-a-boundary"')
  })

  it('returns nothing when the content type carries no boundary', () => {
    expect(parseMultipart('application/json', '{}')).toEqual([])
  })
})

describe('inventoryFunctionsViaStudio', () => {
  const listing = [{ slug: 'hello' }, { slug: 'world' }]

  const fetchFn = (files: Record<string, string>) =>
    async (url: string): Promise<Response> => {
      if (url.endsWith('/functions')) {
        return new Response(JSON.stringify(listing), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const slug = /functions\/([^/]+)\/body$/.exec(url)?.[1] ?? ''
      return new Response(body([{ name: 'index.ts', content: files[slug] ?? '' }]), {
        status: 200, headers: { 'content-type': CT },
      })
    }

  it('lists every function with a content hash', async () => {
    const inv = await inventoryFunctionsViaStudio('http://studio:3000', 'default', fetchFn({ hello: 'a', world: 'b' }))
    expect(inv.map(f => f.slug)).toEqual(['hello', 'world'])
    expect(inv[0].hash).not.toBe(inv[1].hash)
  })

  it('produces a stable hash for identical content', async () => {
    const a = await inventoryFunctionsViaStudio('http://studio:3000', 'default', fetchFn({ hello: 'same', world: 'x' }))
    const b = await inventoryFunctionsViaStudio('http://studio:3000/', 'default', fetchFn({ hello: 'same', world: 'x' }))
    // Trailing slash must not change the result either.
    expect(a[0].hash).toBe(b[0].hash)
  })

  it('surfaces a failed listing rather than reporting no functions', async () => {
    // Reporting an empty inventory would read as "the target has none", which
    // is drift. A broken endpoint is not the same as an empty one.
    const failing = async () => new Response('nope', { status: 500 })
    await expect(inventoryFunctionsViaStudio('http://studio:3000', 'default', failing))
      .rejects.toThrow(/returned 500/)
  })
})
