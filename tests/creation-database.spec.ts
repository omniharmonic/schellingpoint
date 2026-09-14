import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { createClient } from '@supabase/supabase-js'

// These failure-path tests cannot commit an event or grant membership: the
// nonexistent creator fails the FK unless an earlier child write fails first.
loadEnvConfig(process.cwd(), true)
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const local = ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)
test.skip(!local, 'Database regression tests only run against local Supabase')
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth:{persistSession:false,autoRefreshToken:false}})

test('a failed room write rolls back the event rather than returning partial success', async () => {
  const slug = `rollback-room-${Date.now()}`
  const { error } = await db.rpc('create_event_with_program', {
    p_event: {slug,name:'Rollback test',start_date:'2026-10-16',end_date:'2026-10-17',timezone:'UTC',created_by:null,visibility:'private',status:'draft',vote_credits_per_user:36,voting_mechanism:'quadratic'},
    p_venues:[{id:crypto.randomUUID(),name:null,slug:'invalid'}], p_tracks:[],p_time_slots:[],
  })
  expect(error?.code).toBe('23502')
  const {data,error:readError} = await db.from('events').select('id').eq('slug',slug)
  expect(readError).toBeNull()
  expect(data).toEqual([])
})

test('owner membership failure rolls back the entire event', async () => {
  const slug = `rollback-owner-${Date.now()}`
  const { error } = await db.rpc('create_event_with_program', {
    p_event: {slug,name:'Rollback test',start_date:'2026-10-16',end_date:'2026-10-17',timezone:'UTC',created_by:null,visibility:'private',status:'draft',vote_credits_per_user:36,voting_mechanism:'quadratic'},
    p_venues:[],p_tracks:[],p_time_slots:[],
  })
  expect(error?.code).toBe('23502')
  const {data} = await db.from('events').select('id').eq('slug',slug)
  expect(data).toEqual([])
})

test('the transactional create function cannot be called by anonymous clients', async () => {
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {auth:{persistSession:false}})
  const {error} = await anon.rpc('create_event_with_program', {p_event:{},p_venues:[],p_tracks:[],p_time_slots:[]})
  expect(error?.code).toBe('42501')
})

test('completed events reject vote writes at the database boundary', async () => {
  const {data:event} = await db.from('events').select('id').eq('slug','ethboulder-2026').eq('status','completed').single()
  expect(event).not.toBeNull()
  // Nonexistent IDs ensure this test cannot persist a vote even before the guard exists.
  const {error} = await db.from('votes').insert({event_id:event!.id,user_id:crypto.randomUUID(),session_id:crypto.randomUUID(),vote_count:1,credits_spent:1})
  expect(error?.message).toContain('Voting is not open')
})
