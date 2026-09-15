import { gone } from '../gone'

/** 410 Gone — see ../gone.ts. */
export const dynamic = 'force-dynamic'

export async function GET() { return gone() }
export async function POST() { return gone() }
export async function PUT() { return gone() }
export async function PATCH() { return gone() }
export async function DELETE() { return gone() }
