import { canonicalStartPermitClaims, validateStartPermitClaims, type DispatchStartBinding, type DispatchStartPermit, type DispatchStartPermitClaims } from '@shared/queue-dispatch-start-permit.js';
import { createHash, createHmac, timingSafeEqual, sign, verify, type KeyObject } from 'node:crypto';
import { DispatchError } from './errors.js';
export const credentialHash = (credential: string): string => createHash('sha256').update(credential).digest('hex');
export function credentialMatches(credential: unknown, expectedHash: string): boolean {
    return typeof credential === 'string' && /^[a-f0-9]{64}$/.test(expectedHash)
        && timingSafeEqual(Buffer.from(credentialHash(credential), 'hex'), Buffer.from(expectedHash, 'hex'));
}
/** This keyring is dedicated to supervisor attempts, never an API token or a child secret. */
export function createAttemptCredentials(config: {
    credentialKeys: Record<number, Uint8Array>;
    keyVersion: number;
}) {
    if (!Number.isInteger(config.keyVersion) || config.keyVersion < 1 || !config.credentialKeys[config.keyVersion]
        || Object.values(config.credentialKeys).some(key => key.byteLength < 32))
        throw new DispatchError('DISPATCH_ASSERTION_KEY_INVALID');
    function deriveAttemptCredential(attemptId: string, incarnationId: string, generation: number, keyVersion: number): string {
        const key = config.credentialKeys[keyVersion];
        if (!key || !Number.isInteger(generation) || generation < 1)
            throw new DispatchError('DISPATCH_FORBIDDEN');
        return createHmac('sha256', key).update(JSON.stringify(['dispatch-attempt-v1', 'supervisor', attemptId, incarnationId, generation, keyVersion])).digest('base64url');
    }
    return { deriveAttemptCredential };
}
/** Dedicated Ed25519 key: the broker receives only its pinned public counterpart. */
export function createStartPermitSigner(privateKey: KeyObject) {
    if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
        throw new DispatchError('DISPATCH_ASSERTION_KEY_INVALID');
    return (binding: DispatchStartBinding, nowMs: number): DispatchStartPermit => {
        const claims = { version: 1, purpose: 'dispatch-start', ...binding, issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 5000).toISOString() };
        const bytes = Buffer.from(canonicalStartPermitClaims(claims), 'utf8');
        return { permitId: `${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`, expiresAt: claims.expiresAt };
    };
}
/** Adapter example for a trusted broker. expected must come from its own CREATED
 * scope record. Successful verification must be followed by atomic one-shot consumption.
 * Never distribute the attempt-credential key to a broker or execution child.
 */
export function verifyStartPermit(permit: DispatchStartPermit, publicKey: KeyObject, expected: DispatchStartBinding, nowMs: number): DispatchStartPermitClaims {
    try {
        if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
            || typeof permit.permitId !== 'string' || permit.permitId.length > 4096)
            throw Error();
        const parts = permit.permitId.split('.');
        if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)))
            throw Error();
        const bytes = Buffer.from(parts[0], 'base64url'), signature = Buffer.from(parts[1], 'base64url');
        if (bytes.toString('base64url') !== parts[0] || signature.length !== 64 || signature.toString('base64url') !== parts[1]
            || !verify(null, bytes, publicKey, signature))
            throw Error();
        const claims = validateStartPermitClaims(JSON.parse(bytes.toString('utf8')), expected, nowMs);
        if (canonicalStartPermitClaims(claims) !== bytes.toString('utf8') || permit.expiresAt !== claims.expiresAt)
            throw Error();
        return claims;
    }
    catch {
        throw new Error('DISPATCH_START_PERMIT_REFUSED');
    }
}
