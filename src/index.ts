#!/usr/bin/env node
// stdio entrypoint. Construction, mode selection and the runtime presence
// bootstrap live in stdio-server.ts so the exact same surface can also be built
// credentialless by the release canary. See src/stdio-server.ts.
import { startStdioServer } from './stdio-server.js'

startStdioServer().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
