// Real entrypoint constructors and tools; only the telemetry sink is a spy.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createStdioServer } from '../../src/stdio-server.js'
import { createHttpApp } from '../../src/http.js'
import { recordSuccessfulTokenUse } from '../../src/token-usage.js'
import type { TokenUsage } from '../../src/token-usage-observer.js'
const recordTokenUsage = async (usage: TokenUsage) => {
  if (process.env.TOKEN_USAGE_PERSIST === '1') await recordSuccessfulTokenUse(usage)
  console.error('USAGE_SPY:' + JSON.stringify(usage))
}
if (process.argv[2]?.startsWith('http')) {
  const server = createHttpApp(process.argv[2] === 'http-real' ? undefined : recordTokenUsage).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address && typeof address !== 'string') console.error('READY:' + address.port)
  })
} else {
  await createStdioServer({ mode: process.argv[2] === 'canary' ? 'canary' : 'runtime', recordTokenUsage: process.argv[2] === 'real' ? undefined : recordTokenUsage })
    .connect(new StdioServerTransport())
}
