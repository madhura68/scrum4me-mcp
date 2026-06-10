import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

// Start de echte HTTP-entrypoint als kindproces (zoals `npm run dev:http`), wacht tot
// /health antwoordt, stuur SIGTERM en assert dat het proces NETJES (exit 0, niet door het
// signaal gedood) stopt. /health raakt geen DB, dus een dummy DATABASE_URL volstaat.
describe('http graceful shutdown', () => {
  it('stopt schoon op SIGTERM nadat /health up is', async () => {
    const port = 8123
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const child = spawn(tsx, ['src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: 'postgresql://dummy' },
      stdio: 'ignore',
    })
    try {
      let up = false
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`)
          if (r.ok) { up = true; break }
        } catch {
          /* nog niet up */
        }
        await new Promise((res) => setTimeout(res, 250))
      }
      expect(up, '/health kwam niet up').toBe(true)

      child.kill('SIGTERM')
      const [code, signal] = (await once(child, 'exit')) as [number | null, string | null]
      // Schone shutdown = exit 0 via de server.close-callback, niet gedood door het signaal.
      expect(signal).toBeNull()
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 30_000)
})
