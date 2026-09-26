import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The copy budget for the attendee-facing explainer text rewritten in wave A (design
 * 2026-09-26 §6): every muted paragraph says what happens now, in at most two sentences and
 * 160 characters, and the mechanism lives on `/help/privacy` behind a "Learn more" link.
 *
 * A static check on purpose. The sites it guards are one-line descriptions next to a switch, a
 * checkbox or a field — reaching each one in a browser needs a different role, gathering phase
 * and provider configuration, and the thing worth pinning is the source, not the render.
 *
 * `FILES` is an explicit list: this is a guard for the sites the wave rewrote, not a whole-app
 * lint that would fail on somebody else's page the next time they add a sentence. Add a file
 * here when you shorten its copy on purpose.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const root = process.cwd()

const FILES = [
  'src/components/AtprotoSessionActions.tsx',
  'src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx',
  'src/app/e/[slug]/participants/page.tsx',
  'src/app/e/[slug]/settings/page.tsx',
  'src/app/e/[slug]/my-votes/page.tsx',
  'src/components/SettingsModal.tsx',
  'src/components/EditSessionModal.tsx',
  'src/components/HostSessionAnalytics.tsx',
  'src/components/ManageCohostsSection.tsx',
  'src/components/RSVPButton.tsx',
  'src/components/SessionMerge.tsx',
  'src/components/knowledge/AiKeyForm.tsx',
  'src/components/knowledge/AskPanel.tsx',
  'src/components/knowledge/AssistantCard.tsx',
  'src/components/knowledge/TranscriptPanel.tsx',
  'src/components/map/LocationPicker.tsx',
  'src/components/map/VenueMapEditor.tsx',
] as const

/** 160 characters, which is about two sentences a person reads without deciding to. */
const MAX_CHARS = 160

/**
 * Words that describe how the product is built rather than what happens to the reader. They are
 * allowed on `/help/**` — that page's whole job is to explain the mechanism — and nowhere else.
 */
const MECHANISM = /\b(repositor(?:y|ies)|repo|HMAC|fingerprints?|k-suppressed|sealed|records?)\b/i

interface Paragraph {
  file: string
  line: number
  text: string
  raw: string
}

/**
 * The muted explainer paragraphs of a `.tsx` source, as a reader sees them.
 *
 * Link labels are removed with their element: "Learn more" and "How to connect one" are
 * navigation, and counting them would punish a paragraph for handing the mechanism off to
 * `/help` — which is exactly what the design asks it to do. Interpolations (`{…}`) stand in for
 * a name or a number whose length nobody here controls.
 */
function paragraphs(file: string, source: string): Paragraph[] {
  // Copy hoisted to a module constant (`const WHAT_A_COHOST_IS = '…'`) is still copy: resolve the
  // single-line string ones so `{WHAT_A_COHOST_IS}` is measured rather than skipped as a value.
  const constants = new Map<string, string>()
  for (const c of source.matchAll(/^const ([A-Z][A-Z0-9_]*) = '((?:[^'\\]|\\.)*)'$/gm)) {
    constants.set(c[1], c[2].replace(/\\'/g, "'"))
  }

  const patterns = [
    /<p\b[^>]*className="[^"]*text-muted-foreground[^"]*"[^>]*>([\s\S]*?)<\/p>/g,
    /<span\b[^>]*className="[^"]*text-muted-foreground[^"]*"[^>]*>([\s\S]*?)<\/span>/g,
    /<CardDescription\b[^>]*>([\s\S]*?)<\/CardDescription>/g,
  ]
  const found: Paragraph[] = []
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source))) {
      const raw = m[1]
      const text = raw
        .replace(/\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) => constants.get(name) ?? whole)
        .replace(/<(Link|a)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^{}]*\}/g, ' ')
        .replace(/&apos;|&rsquo;/g, '’')
        .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      found.push({ file, line: source.slice(0, m.index).split('\n').length, text, raw })
    }
  }
  return found
}

test.describe('copy budget for the rewritten explainer text', () => {
  let all: Paragraph[] = []

  test.beforeAll(async () => {
    all = []
    for (const file of FILES) {
      const source = await readFile(path.join(root, file), 'utf8')
      all.push(...paragraphs(file, source))
    }
    // A silent zero would make every assertion below pass: the extraction must find something.
    expect(all.length).toBeGreaterThan(30)
  })

  test('no attendee-facing muted paragraph is longer than the budget', () => {
    const over = all
      .filter((p) => p.text.length > MAX_CHARS)
      .map((p) => `${p.file}:${p.line} — ${p.text.length} chars: ${p.text}`)
    expect(over, `over ${MAX_CHARS} characters:\n${over.join('\n')}`).toEqual([])
  })

  test('mechanism words stay on /help', () => {
    const leaked = all
      .filter((p) => MECHANISM.test(p.text))
      .map((p) => `${p.file}:${p.line} — ${p.text}`)
    expect(leaked, `mechanism words outside /help:\n${leaked.join('\n')}`).toEqual([])
  })

  test('/help/privacy answers 200 and carries its five sections', async ({ page }) => {
    const response = await page.goto(`${base}/help/privacy`)
    expect(response?.status()).toBe(200)

    for (const heading of [
      'What is public',
      'What members of a gathering see',
      'What is never stored or shown',
      'Your identity on the open network',
      'AI assistants and transcripts',
    ]) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }

    // Every "Learn more" in the app points at one of these anchors, so the ids must exist.
    for (const id of ['public', 'members', 'never', 'identity', 'assistants']) {
      await expect(page.locator(`#${id}`)).toHaveCount(1)
    }
  })

  test('the help index links to it', async ({ page }) => {
    await page.goto(`${base}/help`)
    await expect(page.getByRole('link', { name: /What is public and what is not/ })).toHaveAttribute(
      'href',
      '/help/privacy',
    )
  })
})
