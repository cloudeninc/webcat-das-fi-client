import { dasQueryDomain, dasQueryDomainAvailable } from 'webcat-das-fi-client'

async function main() {
  try {
    const available: boolean = await dasQueryDomainAvailable('webcat.fi')
    console.log('Domain available:', available)
    const result = await dasQueryDomain('webcat.fi')
    console.log('Status:', result.status)
  } catch (err) {
    console.error('Unexpected error:', err)
  }
}

main()
