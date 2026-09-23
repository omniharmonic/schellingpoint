import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestGathering, TEST_BASE_URL, type TestGathering } from './helpers/gathering'

/**
 * Automated accessibility assertions (MT §12.9, audit 21.5).
 *
 * The audit's finding was not "the app is inaccessible" — the primitives are good — but that
 * *nothing checked*, so a regression had no way of being noticed. This is that check: axe-core
 * over the six surfaces a person actually arrives on, failing on `serious` and `critical`
 * violations only.
 *
 * Why that threshold: `minor` and `moderate` findings are dominated by judgement calls axe
 * cannot make (decorative contrast, landmark opinions), and a gate that cries wolf gets
 * disabled. `serious` and `critical` are the ones that stop somebody using the page.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('accessibility', () => {
  test.skip(!ownerUrl, 'needs the local stack and the dev server')

  let sql: postgres.Sql
  let gathering: TestGathering

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    // A gathering of this suite's own, so no seeded row is read or written.
    gathering = await createTestGathering(sql, { tag: 'a11y', status: 'published', visibility: 'public', withProgram: true })
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await sql?.end({ timeout: 5 })
  })

  const pages = () => [
    { name: 'home', path: '/' },
    { name: 'gatherings directory', path: '/events' },
    { name: 'gatherings directory, filtered', path: '/events?when=all&place=in-person' },
    { name: 'sign in', path: '/login' },
    { name: 'code of conduct', path: '/codeofconduct' },
    { name: 'a gathering', path: `/e/${gathering.slug}` },
  ]

  test('six key pages have no serious or critical accessibility violations', async ({ page }) => {
    test.setTimeout(120_000)
    const failures: string[] = []

    for (const target of pages()) {
      const response = await page.goto(`${base}${target.path}`, { waitUntil: 'domcontentloaded' })
      expect(response?.status(), `${target.name} should render`).toBeLessThan(400)
      // Client components hydrate and fill in their own regions; let the page settle first.
      await page.waitForLoadState('networkidle').catch(() => undefined)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      for (const violation of results.violations) {
        if (violation.impact !== 'serious' && violation.impact !== 'critical') continue
        const where = violation.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')
        failures.push(`${target.name} (${target.path}): ${violation.id} [${violation.impact}] — ${violation.help} — ${where}`)
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
  })

  /**
   * The Radix dialog contract, as a regression guard.
   *
   * Radix wires `aria-describedby` on a DialogContent to the id it generates for its
   * DialogDescription, and warns when that id is not in the document. The onboarding modal used
   * to set both by hand — and the hand-written `id` overrode the generated one, so the link
   * pointed at nothing and the console warned on every sign-up. The rule that prevents it
   * coming back: every dialog has a description, and nobody hand-wires the ids.
   */
  test('every dialog has a description, and nobody hand-wires Radix’s description ids', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith('.tsx')) files.push(full)
      }
    }
    walk(join(process.cwd(), 'src'))

    const problems: string[] = []
    for (const file of files) {
      if (file.endsWith(join('components', 'ui', 'dialog.tsx'))) continue
      const source = readFileSync(file, 'utf8')
      const usesDialog = source.includes('<DialogContent') || source.includes('<Dialog.Content')
      if (!usesDialog) continue
      const described =
        source.includes('<DialogDescription') ||
        source.includes('<Dialog.Description') ||
        source.includes('aria-describedby={undefined}')
      if (!described) problems.push(`${file}: a dialog with no description (add DialogDescription, or aria-describedby={undefined} on purpose)`)
      // Only on the dialog itself: `aria-describedby` on a form field is exactly right.
      if (/<(?:DialogContent|Dialog\.Content)\b[^>]*aria-describedby="/.test(source)) {
        problems.push(`${file}: hand-written aria-describedby on a dialog — let Radix wire its own DialogDescription id`)
      }
    }

    expect(problems, problems.join('\n')).toEqual([])
  })
})
