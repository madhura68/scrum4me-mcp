import { createHash } from 'crypto'
import { prisma } from './prisma.js'

export type AuthContext = {
  userId: string
  username: string
  isDemo: boolean
}

let cached: AuthContext | null = null

export async function getAuth(): Promise<AuthContext> {
  if (cached) return cached

  const token = process.env.SCRUM4ME_TOKEN
  if (!token) {
    throw new Error('SCRUM4ME_TOKEN is not set — see .env.example')
  }

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const apiToken = await prisma.apiToken.findUnique({
    where: { token_hash: tokenHash },
    include: { user: true },
  })

  if (!apiToken || apiToken.revoked_at) {
    throw new Error('SCRUM4ME_TOKEN is invalid or revoked')
  }

  cached = {
    userId: apiToken.user_id,
    username: apiToken.user.username,
    isDemo: apiToken.user.is_demo,
  }
  return cached
}

export class PermissionDeniedError extends Error {
  constructor(message = 'Demo accounts cannot perform write operations') {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

export async function requireWriteAccess(): Promise<AuthContext> {
  const auth = await getAuth()
  if (auth.isDemo) {
    throw new PermissionDeniedError()
  }
  return auth
}
