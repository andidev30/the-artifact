import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

// Published pages are written by people and their agents, not by us, so their frames are left out
const NOT_OURS = ['iframe.viewer-frame']

type Options = {
  // Only check this part of the screen, e.g. an open dialog
  include?: string
}

// Runs axe with the WCAG 2.1 A and AA rules against what is on screen now, once with the light and
// once with the dark colour scheme preference, and fails with a readable list of what it found
export async function expectAccessible(page: Page, name: string, options: Options = {}) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    let builder = new AxeBuilder({ page }).withTags(WCAG_AA)
    for (const selector of NOT_OURS) builder = builder.exclude(selector)
    if (options.include) builder = builder.include(options.include)
    const { violations } = await builder.analyze()
    const found = violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1).join('; ')}`).join('\n')}`,
    )
    expect.soft(found, `axe on ${name}, ${colorScheme} scheme`).toEqual([])
  }
  await page.emulateMedia({ colorScheme: null })
}
