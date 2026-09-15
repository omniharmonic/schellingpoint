/**
 * ENS verification primitives (spec §7): resolve an ENS name's address over plain JSON-RPC and
 * recover the signer of an EIP-191 `personal_sign` message.
 *
 * Pure apart from `resolveEnsAddress`'s injected `fetch`; no `server-only`, so tests import it.
 *
 * Dependencies: `@noble/hashes` (keccak-256) and `@noble/curves` (secp256k1 recovery). Both are
 * present transitively through `@atproto/crypto`; they should be declared in package.json.
 *
 * Limits, stated: resolution reads the ENS registry's resolver for the name and calls
 * `addr(bytes32)`. Wildcard (ENSIP-10) and offchain (CCIP-read) names and smart-contract wallets
 * (ERC-1271 signatures) are not supported yet; names must be ASCII (see `normalizeEnsName`).
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from '@noble/curves/secp256k1'

/** ENS registry, identical on mainnet and every major testnet. */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const SELECTOR_RESOLVER = '0178b8bf' // resolver(bytes32)
const SELECTOR_ADDR = '3b3b57de' // addr(bytes32)

export const DEFAULT_ENS_RPC_URLS = ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com']

export class EnsResolutionError extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'no_resolver' | 'no_address') {
    super(message)
    this.name = 'EnsResolutionError'
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s)

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('invalid hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** EIP-137 namehash of an already-normalized name. */
export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32)
  if (!name) return node
  for (const label of name.split('.').reverse()) {
    const buf = new Uint8Array(64)
    buf.set(node, 0)
    buf.set(keccak_256(utf8(label)), 32)
    node = keccak_256(buf)
  }
  return node
}

/** EIP-191 version 0x45 digest: keccak256("\x19Ethereum Signed Message:\n" + len + message). */
export function personalMessageHash(message: string): Uint8Array {
  const body = utf8(message)
  const prefix = utf8(`\x19Ethereum Signed Message:\n${body.length}`)
  const buf = new Uint8Array(prefix.length + body.length)
  buf.set(prefix, 0)
  buf.set(body, prefix.length)
  return keccak_256(buf)
}

/** Lowercase 0x address of an uncompressed secp256k1 public key (65 bytes, 0x04 prefix). */
export function addressFromPublicKey(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 4) throw new Error('expected an uncompressed public key')
  return `0x${toHex(keccak_256(uncompressed.slice(1)).slice(-20))}`
}

/** A 65-byte `r‖s‖v` signature as 0x-hex, v ∈ {0, 1, 27, 28}. */
export function isSignatureHex(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)
}

/**
 * The lowercase address that produced `signature` over `message` with `personal_sign`, or null
 * when the signature is malformed or does not recover to a point.
 */
export function recoverPersonalSignAddress(message: string, signature: string): string | null {
  if (!isSignatureHex(signature)) return null
  const bytes = fromHex(signature)
  let v = bytes[64]
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) return null
  try {
    const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(v)
    const point = sig.recoverPublicKey(personalMessageHash(message))
    return addressFromPublicKey(point.toRawBytes(false))
  } catch {
    return null
  }
}

/** The challenge text the wallet signs. Binds the name, the account's DID, a nonce and an expiry. */
export function ensChallengeMessage(input: { host: string; name: string; did: string; nonce: string; expiresAt: string }): string {
  return [
    `${input.host} asks you to verify an ENS name.`,
    '',
    `ENS name: ${input.name}`,
    `Account: ${input.did}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expiresAt}`,
    '',
    'Signing proves you control the address this name resolves to. It sends no transaction and costs nothing.',
  ].join('\n')
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

async function ethCall(rpcUrls: string[], to: string, data: string, fetchImpl: FetchLike): Promise<string> {
  let lastError = 'no RPC endpoint configured'
  for (const url of rpcUrls) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(8000),
      })
      const json = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null
      if (res.ok && json && typeof json.result === 'string' && /^0x[0-9a-fA-F]*$/.test(json.result)) return json.result
      lastError = json?.error?.message ?? `HTTP ${res.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  throw new EnsResolutionError(`Ethereum RPC unavailable: ${lastError}`, 'unavailable')
}

function addressWord(result: string): string | null {
  const hex = result.slice(2)
  if (hex.length < 64) return null
  const addr = `0x${hex.slice(24, 64).toLowerCase()}`
  return /^0x0{40}$/.test(addr) ? null : addr
}

/** Resolve a normalized ENS name to its lowercase ETH address (`addr(bytes32)`). */
export async function resolveEnsAddress(
  name: string,
  opts: { rpcUrls?: string[]; fetch?: FetchLike } = {},
): Promise<string> {
  const rpcUrls = opts.rpcUrls?.length ? opts.rpcUrls : DEFAULT_ENS_RPC_URLS
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
  const node = toHex(namehash(name))
  const resolver = addressWord(await ethCall(rpcUrls, ENS_REGISTRY, `0x${SELECTOR_RESOLVER}${node}`, fetchImpl))
  if (!resolver) throw new EnsResolutionError(`${name} has no ENS resolver`, 'no_resolver')
  const address = addressWord(await ethCall(rpcUrls, resolver, `0x${SELECTOR_ADDR}${node}`, fetchImpl))
  if (!address) throw new EnsResolutionError(`${name} does not resolve to an address`, 'no_address')
  return address
}

/** RPC endpoints from `ENS_RPC_URL` (comma-separated), else the defaults. */
export function ensRpcUrls(env: string | undefined = process.env.ENS_RPC_URL): string[] {
  const list = (env ?? '').split(',').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s))
  return list.length ? list : DEFAULT_ENS_RPC_URLS
}
