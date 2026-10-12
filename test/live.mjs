// Queries the real DAS at das.domain.fi. Run with npm run test:live.
import assert from 'node:assert/strict'
import { dasQueryDomain, dasQueryDomainAvailable } from '../lib/index.js'

const free = `webcat-das-fi-client-test-${Date.now()}.fi`
const checks = [
  ['webcat.fi', 'active'],
  ['WebCat.FI', 'active'],
  ['ääkkönen.fi', 'active'],
  ['xn--kknen-fraa0m.fi', 'active'],
  [free, 'available'],
  ['a.fi', 'invalid'],
]
for (const [domain, status] of checks) {
  const result = await dasQueryDomain(domain)
  console.log(`${domain} -> ${result.domain}: ${result.status}`)
  assert.equal(result.status, status, result.response)
}
assert.equal(await dasQueryDomainAvailable('webcat.fi'), false)
assert.equal(await dasQueryDomainAvailable(free), true)

// Parallel queries must each get their own answer.
const names = Array.from({ length: 50 }, (_, i) => i % 2 ? `webcat-das-fi-client-test-${i}-${Date.now()}.fi` : 'webcat.fi')
const results = await Promise.all(names.map((name) => dasQueryDomain(name)))
results.forEach((result, i) => assert.equal(result.available, i % 2 === 1, `${names[i]}: ${result.response}`))
console.log(`${names.length} parallel queries answered correctly`)
