import * as dgram from 'node:dgram'
import * as dns from 'node:dns'
import * as url from 'node:url'
import * as xml2js from 'xml2js'

export const DAS_SERVER = 'das.domain.fi'
export const DAS_PORT = 715

export interface DasQueryOptions {
  /** DAS server hostname or IPv4 address. Default das.domain.fi. */
  server?: string
  /** DAS server UDP port. Default 715. */
  port?: number
  /** How long to wait for a response to each attempt, in milliseconds. Default 2000. */
  timeout?: number
  /** How many times to resend the query when no response arrives. Default 2. */
  retries?: number
}

export interface DasQueryResult {
  /** The domain name as queried, normalized to lowercase ASCII (punycode) form. */
  domain: string
  /** True only when DAS reports the domain as available. */
  available: boolean
  /** The status DAS reported: available, active, invalid, or another status element name. */
  status: string
  /** The raw XML response from DAS. */
  response: string
}

export class DasError extends Error {
  /** The raw XML response from DAS, if one was received. */
  response?: string

  constructor(message: string, response?: string) {
    super(message)
    this.name = 'DasError'
    this.response = response
  }
}

function xmlEncode(str: string) {
  return str.replace(/[<>&'"]/g, (c: string) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

/**
 * Normalize a domain name to lowercase ASCII (punycode) form, in which queries are sent and
 * responses compared. DAS reports uppercase names invalid, and answers a punycode query with
 * the Unicode name. A name that is not a valid hostname is only trimmed and lowercased, and
 * DAS reports it invalid.
 */
export function normalizeDomain(domain: string): string {
  const name = domain.trim().toLowerCase().replace(/\.$/, '')
  return url.domainToASCII(name) || name
}

function buildQuery(domain: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<iris1:request xmlns:iris1="urn:ietf:params:xml:ns:iris1">' +
    '<iris1:searchSet>' +
    '<iris1:lookupEntity registryType="dchk1" entityClass="domain-name" entityName="' + xmlEncode(domain) + '"/>' +
    '</iris1:searchSet>' +
    '</iris1:request>'
}

interface ParsedResponse {
  domainName: string
  status: string | undefined
}

async function parseResponse(response: string): Promise<ParsedResponse> {
  let doc: any
  try {
    doc = await xml2js.parseStringPromise(response)
  } catch (err) {
    throw new DasError('Invalid DAS response: ' + (err as Error).message, response)
  }
  const domain = doc && doc.domain
  if (!domain) {
    throw new DasError('Invalid DAS response: no domain element', response)
  }
  // <domainName>x.fi</domainName> parses to a string, <domainName /> to an empty string,
  // and an element with attributes to an object holding its text in _.
  const domainName = domain.domainName && domain.domainName[0]
  const status = domain.status && domain.status[0]
  return {
    domainName: typeof domainName === 'string' ? domainName : (domainName && domainName._) || '',
    status: status && typeof status === 'object' ? Object.keys(status).find((key) => key !== '$' && key !== '_') : undefined,
  }
}

function lookup(server: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(server, { family: 4 }, (err, address) => {
      if (err) reject(err)
      else resolve(address)
    })
  })
}

/**
 * Query DAS for a domain and return its status with the raw response. Each attempt waits
 * `timeout` milliseconds, and a query that gets no answer is resent `retries` times.
 * Responses from other addresses or about other domains are ignored, so a late or stray
 * packet can never answer the wrong query.
 */
export async function dasQueryDomain(domain: string, options: DasQueryOptions = {}): Promise<DasQueryResult> {
  const server = options.server ?? DAS_SERVER
  const port = options.port ?? DAS_PORT
  const timeout = options.timeout ?? 2000
  const retries = options.retries ?? 2
  const name = normalizeDomain(domain)
  const query = buildQuery(name)
  const address = await lookup(server)

  return new Promise<DasQueryResult>((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    let attempts = 0
    let timer: NodeJS.Timeout | undefined
    let settled = false
    // The last response that did not answer this query, kept for the timeout error.
    let ignored: DasError | undefined

    function finish(err: Error | undefined, result?: DasQueryResult) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (err) reject(err)
      else resolve(result!)
    }

    function send() {
      attempts++
      // send() reports some errors, such as an invalid port, by throwing rather than through
      // its callback, and this runs outside the Promise executor.
      try {
        socket.send(query, port, address, (err) => {
          if (err) finish(err)
        })
      } catch (err) {
        finish(err as Error)
        return
      }
      timer = setTimeout(() => {
        if (attempts <= retries) {
          send()
        } else {
          const reason = ignored ? ` (last ignored response: ${ignored.message})` : ''
          finish(new DasError(`DAS query for ${name} timed out after ${attempts} attempts${reason}`, ignored && ignored.response))
        }
      }, timeout)
    }

    socket.on('error', (err) => finish(err))
    socket.on('message', (msg, rinfo) => {
      if (settled || rinfo.address !== address || rinfo.port !== port) return
      const response = msg.toString('utf8')
      parseResponse(response).then((parsed) => {
        if (normalizeDomain(parsed.domainName) !== name) {
          ignored = new DasError(`response is for ${JSON.stringify(parsed.domainName)}`, response)
        } else if (!parsed.status) {
          finish(new DasError(`Invalid DAS response for ${name}: no status`, response))
        } else {
          finish(undefined, { domain: name, available: parsed.status === 'available', status: parsed.status, response })
        }
      }, (err: DasError) => {
        ignored = err
      })
    })
    socket.bind(() => send())
  })
}

/**
 * Check from DAS whether a .fi domain is available for registration. Returns true when DAS
 * reports it available and false when it is taken or otherwise unavailable. Throws a DasError
 * when DAS reports the name invalid, or the query times out or gets an unexpected response.
 */
export async function dasQueryDomainAvailable(domain: string, options: DasQueryOptions = {}): Promise<boolean> {
  const result = await dasQueryDomain(domain, options)
  if (result.status === 'invalid') {
    throw new DasError(`Invalid DAS request for ${result.domain}`, result.response)
  }
  return result.available
}
