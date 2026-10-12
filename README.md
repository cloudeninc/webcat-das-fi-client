# WebCat .fi Domain Availability Service Client

Copyright (C) WebCat & Clouden Oy 2019-2026, author Kenneth Falck <kennu@clouden.net>.

Released under the MIT license.

## Overview

This is a simple Node.js / TypeScript client library for checking whether a domain is available in the .fi domain registry.

We use this library in the https://webcat.fi domain registrar service to check for available domains.

You can find more information about the DAS service at https://www.traficom.fi/en/communications/fi-domains/domain-name-registrars.

## Installation

    npm install webcat-das-fi-client

Requires Node.js 18 or later.

## Usage

```typescript
import { dasQueryDomainAvailable } from 'webcat-das-fi-client'

async function main() {
  try {
    const available: boolean = await dasQueryDomainAvailable('webcat.fi')
    console.log('Domain available:', available)
  } catch (err) {
    console.error('Unexpected error:', err)
  }
}

main()
```

`dasQueryDomainAvailable` returns true when DAS reports the domain available, and false when it is
taken or otherwise unavailable. It throws a `DasError` when DAS reports the name invalid, when the
query times out, or when the response cannot be understood. The error's `response` property holds
the raw XML response, if one was received.

To see the status DAS reported and its raw response, for logging for instance, use `dasQueryDomain`:

```typescript
import { dasQueryDomain } from 'webcat-das-fi-client'

const result = await dasQueryDomain('webcat.fi')
// { domain: 'webcat.fi', available: false, status: 'active', response: '<?xml ...' }
```

`status` is the name of the status element DAS sent, such as `available`, `active` or `invalid`.
`dasQueryDomain` does not throw on an invalid name; it returns status `invalid`.

Domain names are sent in lowercase ASCII (punycode) form, so `WebCat.FI` and `ääkkönen.fi`
(`xn--kknen-fraa0m.fi`) work as expected. The result's `domain` is in that form.

### Options

Both functions take an optional second argument:

| Option    | Default         | Meaning                                                  |
|-----------|-----------------|----------------------------------------------------------|
| `server`  | `das.domain.fi` | DAS server hostname or IPv4 address                      |
| `port`    | `715`           | DAS server UDP port                                      |
| `timeout` | `2000`          | Milliseconds to wait for a response to each attempt      |
| `retries` | `2`             | How many times to resend a query that gets no response   |

DAS is queried over UDP. A response is accepted only if it comes from the server's address and
port and names the domain that was queried, so a stray or late packet cannot answer the wrong
query.

## Changes in 2.0.0

- Queries time out and are retried, instead of waiting forever for a lost UDP packet.
- Responses are checked against the queried domain and the server's address.
- Names are normalized to lowercase punycode. Uppercase names used to be reported invalid.
- A response without a status throws a `DasError` instead of a `TypeError`.
- New `dasQueryDomain` returns the status and raw response, and errors carry the raw response.
- Requires Node.js 18 or later.

## Development

    npm install
    npm test            # unit tests against a fake DAS server
    npm run test:live   # queries the real das.domain.fi
