import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { dasQueryDomain, dasQueryDomainAvailable, normalizeDomain, DasError } from '../lib/index.js'

function reply(domain, status) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<domain authority="domain.fi" registryType="dchk1" entityClass="domain-name" entityName="${domain}">\n` +
    `  <domainName>${domain}</domainName>\n` +
    `  <status>\n    <${status} />\n  </status>\n</domain>`
}

function queriedName(msg) {
  return msg.toString().match(/entityName="([^"]*)"/)[1]
}

// A fake DAS server. The handler gets each query's domain name and attempt number and
// returns the packets to send back, or nothing to drop the query.
async function fakeDas(handler) {
  const server = dgram.createSocket('udp4')
  const queries = []
  server.on('message', (msg, rinfo) => {
    const name = queriedName(msg)
    queries.push(name)
    const packets = handler(name, queries.filter((q) => q === name).length, rinfo) || []
    for (const packet of [].concat(packets)) {
      server.send(packet, rinfo.port, rinfo.address)
    }
  })
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve))
  return {
    options: { server: '127.0.0.1', port: server.address().port, timeout: 100, retries: 2 },
    queries,
    close: () => server.close(),
  }
}

test('reports available, taken and other statuses', async () => {
  const das = await fakeDas((name) => reply(name, { 'free.fi': 'available', 'taken.fi': 'active', 'held.fi': 'reserved' }[name] || 'invalid'))
  try {
    assert.equal(await dasQueryDomainAvailable('free.fi', das.options), true)
    assert.equal(await dasQueryDomainAvailable('taken.fi', das.options), false)
    assert.equal(await dasQueryDomainAvailable('held.fi', das.options), false)
    const result = await dasQueryDomain('held.fi', das.options)
    assert.equal(result.status, 'reserved')
    assert.equal(result.available, false)
    assert.match(result.response, /<reserved \/>/)
  } finally {
    das.close()
  }
})

test('throws on an invalid name, with the response', async () => {
  const das = await fakeDas((name) => reply(name, 'invalid'))
  try {
    await assert.rejects(dasQueryDomainAvailable('a.fi', das.options), (err) => {
      assert.ok(err instanceof DasError)
      assert.match(err.message, /Invalid DAS request for a\.fi/)
      assert.match(err.response, /<invalid \/>/)
      return true
    })
    assert.equal((await dasQueryDomain('a.fi', das.options)).status, 'invalid')
  } finally {
    das.close()
  }
})

test('ignores a response about another domain and waits for its own', async () => {
  const das = await fakeDas((name) => [reply('other.fi', 'available'), reply(name, 'active')])
  try {
    assert.equal(await dasQueryDomainAvailable('taken.fi', das.options), false)
  } finally {
    das.close()
  }
})

test('never takes another domain\'s answer, and times out naming it', async () => {
  const das = await fakeDas(() => reply('other.fi', 'available'))
  try {
    await assert.rejects(dasQueryDomainAvailable('taken.fi', das.options), (err) => {
      assert.ok(err instanceof DasError)
      assert.match(err.message, /timed out after 3 attempts \(last ignored response: response is for "other\.fi"\)/)
      assert.match(err.response, /other\.fi/)
      return true
    })
    assert.equal(das.queries.length, 3)
  } finally {
    das.close()
  }
})

test('resends a query that gets no response', async () => {
  const das = await fakeDas((name, attempt) => attempt < 3 ? undefined : reply(name, 'available'))
  try {
    assert.equal(await dasQueryDomainAvailable('free.fi', das.options), true)
    assert.equal(das.queries.length, 3)
  } finally {
    das.close()
  }
})

test('times out when the server never answers', async () => {
  const das = await fakeDas(() => undefined)
  try {
    const start = Date.now()
    await assert.rejects(dasQueryDomainAvailable('free.fi', { ...das.options, retries: 1 }), /timed out after 2 attempts$/)
    assert.ok(Date.now() - start >= 200)
    assert.equal(das.queries.length, 2)
  } finally {
    das.close()
  }
})

test('ignores packets from another source', async () => {
  const impostor = dgram.createSocket('udp4')
  await new Promise((resolve) => impostor.bind(0, '127.0.0.1', resolve))
  const das = await fakeDas((name, attempt, rinfo) => {
    if (attempt === 1) impostor.send(reply(name, 'available'), rinfo.port, rinfo.address)
    else return reply(name, 'active')
  })
  try {
    assert.equal(await dasQueryDomainAvailable('taken.fi', das.options), false)
    assert.equal(das.queries.length, 2)
  } finally {
    das.close()
    impostor.close()
  }
})

test('skips a malformed packet and reports it if nothing better arrives', async () => {
  const good = await fakeDas((name) => ['<domain><broken', reply(name, 'active')])
  const bad = await fakeDas(() => '<domain><broken')
  try {
    assert.equal(await dasQueryDomainAvailable('taken.fi', good.options), false)
    await assert.rejects(dasQueryDomainAvailable('taken.fi', bad.options), /timed out after 3 attempts \(last ignored response: Invalid DAS response: /)
  } finally {
    good.close()
    bad.close()
  }
})

test('throws on a response without a status', async () => {
  const das = await fakeDas((name) => `<domain><domainName>${name}</domainName></domain>`)
  try {
    await assert.rejects(dasQueryDomainAvailable('free.fi', das.options), /no status/)
  } finally {
    das.close()
  }
})

test('queries in lowercase punycode and matches Unicode answers', async () => {
  // DAS answers a punycode query with the Unicode name.
  const das = await fakeDas((name) => reply(name === 'xn--kknen-fraa0m.fi' ? 'ääkkönen.fi' : name, 'available'))
  try {
    const result = await dasQueryDomain(' Xn--Kknen-Fraa0m.FI. ', das.options)
    assert.equal(das.queries[0], 'xn--kknen-fraa0m.fi')
    assert.equal(result.domain, 'xn--kknen-fraa0m.fi')
    assert.equal(result.available, true)
    assert.equal(await dasQueryDomainAvailable('ÄÄKKÖNEN.fi', das.options), true)
    assert.equal(das.queries[1], 'xn--kknen-fraa0m.fi')
    assert.equal(await dasQueryDomainAvailable('WebCat.FI', das.options), true)
    assert.equal(das.queries[2], 'webcat.fi')
  } finally {
    das.close()
  }
})

test('escapes the name in the query', async () => {
  // The queried name arrives escaped, so echoing it back is valid XML for the original name.
  const das = await fakeDas((name) => reply(name, 'invalid'))
  try {
    assert.equal((await dasQueryDomain('a"<&.fi', das.options)).status, 'invalid')
    assert.equal(das.queries[0], 'a&quot;&lt;&amp;.fi')
  } finally {
    das.close()
  }
})

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('WebCat.FI'), 'webcat.fi')
  assert.equal(normalizeDomain('webcat.fi.'), 'webcat.fi')
  assert.equal(normalizeDomain('ÄKKÖ.fi'), 'xn--kk-uia8e.fi')
  assert.equal(normalizeDomain('äkkö.fi'), 'xn--kk-uia8e.fi')
  assert.equal(normalizeDomain('XN--KK-UIA8E.FI'), 'xn--kk-uia8e.fi')
  assert.equal(normalizeDomain('bad name.fi'), 'bad name.fi')
})
