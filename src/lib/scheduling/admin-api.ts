import 'server-only'
/**
 * Shared plumbing for the organizer admin API (work package D).
 *
 * Every admin route resolves the event with `requireEventRole` (404 for hidden events to
 * non-members, 401 without a viewer, 403 for the wrong role), runs `assertSameOrigin` on
 * mutations, and filters every query by the resolved `event.id`.
 */
import { NextResponse } from 'next/server'
import { assertSameOrigin, requireEventRole, type Viewer, type ViewerEvent } from '@/lib/auth/viewer'
import { canRolePerform, type Permission } from '@/lib/permissions'
import { dbErrorResponse, pgErrorCode } from '@/lib/db'
import type { EventRoleName } from '@/types/event'

export const ALL_ROLES: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Roles that hold every one of `permissions` (src/lib/permissions.ts is the source of truth). */
export function rolesWith(...permissions: Permission[]): EventRoleName[] {
  return ALL_ROLES.filter((role) => permissions.every((p) => canRolePerform(role, p)))
}

/** Roles that hold at least one of `permissions`. */
export function rolesWithAny(...permissions: Permission[]): EventRoleName[] {
  return ALL_ROLES.filter((role) => permissions.some((p) => canRolePerform(role, p)))
}

export interface OrganizerContext {
  viewer: Viewer
  event: ViewerEvent
  role: EventRoleName
}

/**
 * Same-origin check for unsafe methods, then the event role check. Returns the context
 * or the response to send.
 */
export async function requireOrganizer(
  request: Request,
  slug: string,
  roles: readonly EventRoleName[],
): Promise<OrganizerContext | Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  return requireEventRole(request, slug, roles)
}

export function json(body: unknown, init: { status?: number } = {}): Response {
  return NextResponse.json(body, { status: init.status ?? 200, headers: NO_STORE })
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

/** A JSON object body, or a 400 response. */
export async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail(400, 'Invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Thrown by validators; routes turn it into a 400 with the offending field. */
export class InputError extends Error {
  constructor(message: string, readonly field?: string, readonly status = 400, readonly code?: string) {
    super(message)
    this.name = 'InputError'
  }
}

export function text(
  body: Record<string, unknown>,
  field: string,
  opts: { required?: boolean; max: number; label?: string },
): string | null {
  const raw = body[field]
  const label = opts.label ?? field
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (opts.required) throw new InputError(`${label} is required`, field)
    return null
  }
  if (typeof raw !== 'string') throw new InputError(`${label} must be text`, field)
  const value = raw.trim()
  if (value.length > opts.max) throw new InputError(`${label} must be at most ${opts.max} characters`, field)
  return value
}

export function integer(
  body: Record<string, unknown>,
  field: string,
  opts: { required?: boolean; min: number; max: number; label?: string },
): number | null {
  const raw = body[field]
  const label = opts.label ?? field
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new InputError(`${label} is required`, field)
    return null
  }
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new InputError(`${label} must be a whole number between ${opts.min} and ${opts.max}`, field)
  }
  return n
}

export function uuidOrNull(body: Record<string, unknown>, field: string, label = field): string | null {
  const raw = body[field]
  if (raw === undefined || raw === null || raw === '') return null
  if (!isUuid(raw)) throw new InputError(`${label} is not a valid id`, field)
  return raw
}

export function stringList(
  body: Record<string, unknown>,
  field: string,
  opts: { maxItems: number; maxLength: number; label?: string; pattern?: RegExp },
): string[] | null {
  const raw = body[field]
  const label = opts.label ?? field
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) throw new InputError(`${label} must be a list`, field)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new InputError(`${label} must contain text only`, field)
    const value = item.trim()
    if (!value) continue
    if (value.length > opts.maxLength) throw new InputError(`${label} entries must be at most ${opts.maxLength} characters`, field)
    if (opts.pattern && !opts.pattern.test(value)) throw new InputError(`${label} contains an invalid entry`, field)
    if (!out.includes(value)) out.push(value)
  }
  if (out.length > opts.maxItems) throw new InputError(`${label} can have at most ${opts.maxItems} entries`, field)
  return out
}

/** Map validation and database errors to responses; rethrow anything else. */
export function errorResponse(e: unknown, context: string): Response {
  if (e instanceof InputError) {
    return fail(e.status, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}) })
  }
  const mapped = dbErrorResponse(e)
  if (mapped) return mapped
  console.error(`[admin] ${context}:`, pgErrorCode(e) ?? '', e instanceof Error ? e.message : e)
  return fail(500, 'Something went wrong. Please try again.')
}

export const SESSION_FORMATS = ['talk', 'workshop', 'discussion', 'panel', 'demo', 'fireside', 'ceremony'] as const
export const SLOT_TYPES = ['session', 'break', 'checkin', 'unconference', 'track'] as const
export const HEX_COLOR = /^#[0-9a-f]{6}$/i
export const SKILL_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/freeschool\.draft\.skill\/[A-Za-z0-9._~:-]{1,512}$/

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
