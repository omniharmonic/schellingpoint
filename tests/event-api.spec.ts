import { test, expect } from '@playwright/test'
const base = 'http://127.0.0.1:3001'

test('creation and settings reject unsigned requests before mutation', async ({request}) => {
  const create = await request.post(`${base}/api/events/create`, {data:{wizardState:{}}})
  expect(create.status()).toBe(401)
  const settings = await request.patch(`${base}/api/events/00000000-0000-0000-0000-000000000000/settings`, {data:{status:'published'}})
  expect(settings.status()).toBe(401)
})

test('slug validation handles malformed requests without a server error', async ({request}) => {
  for (const data of [null,{}, {slug:123}, {slug:'bad slug'}]) {
    const response = await request.post(`${base}/api/events/validate-slug`, {data:JSON.stringify(data),headers:{'Content-Type':'application/json'}})
    expect(response.status()).toBe(400)
    expect((await response.json()).available).toBe(false)
  }
})

test('slug availability identifies an existing event', async ({request}) => {
  const response = await request.post(`${base}/api/events/validate-slug`, {data:{slug:'ethboulder-2026'}})
  expect(response.ok()).toBe(true)
  expect((await response.json()).available).toBe(false)
})
