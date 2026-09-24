// The cog on a service's tab: opens the dialog, reads what it says about the
// stacks the tab fronts, and — in MODE=move — moves a hostname's label in the
// draft, reads the Apply bar's words for it, and puts it back.
//
//   MODE=look (default)   open the dialog on AI › Consumers and read it
//   MODE=move             also move open-webui's label to LAB_LABEL (chat2)
//                         and back through "as the host says"
export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1400 })
  const errs = []
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  const mode = process.env.MODE ?? 'look'
  const label = process.env.LAB_LABEL ?? 'chat2'

  await page.goto(`${base}/c/ai?tab=consumers`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  const tabs = await page.$$eval('main nav a', (as) =>
    as.map((a) => a.innerText.replace(/\s+/g, ' ').trim()),
  )
  log(`tabs: ${JSON.stringify(tabs)}`)
  const foot = await page.$$eval('main h3', (hs) => hs.map((h) => h.textContent.trim()))
  if (foot.includes('This service')) throw new Error('the old footer is still drawn')

  const cog = page.locator('main nav button[aria-label^="Settings for"]')
  log(`cogs on the tab bar: ${await cog.count()} (${await cog.first().getAttribute('aria-label')})`)
  if ((await cog.count()) !== 1) throw new Error('expected exactly one cog on the tab bar')
  await cog.click()
  await page.waitForTimeout(2500)
  const dialog = page.locator('[role="dialog"]')
  const text = (await dialog.innerText()).replace(/\s+/g, ' ')
  log(`dialog: ${text.slice(0, 700)}`)
  await snap('dialog')
  for (const needle of ['n8n', 'open-webui', 'toscanini.me', 'LAN only', 'next Apply']) {
    if (!text.includes(needle)) throw new Error(`dialog does not say "${needle}"`)
  }
  const inputs = await dialog.locator('input[type="text"], input:not([type])').count()
  const switches = await dialog.locator('[role="switch"]').count()
  log(`label inputs: ${inputs}, switches: ${switches}`)
  if (inputs < 1 || switches < 2) throw new Error('the dialog is missing its controls')

  if (mode === 'move') {
    // The open-webui row's input is the one holding "chat".
    const box = dialog.locator('input').first()
    const before = await box.inputValue()
    log(`open-webui label before: ${before}`)
    if (before !== 'chat') throw new Error(`expected the chat label first, got ${before}`)
    await box.fill(label)
    await box.press('Enter')
    await page.waitForTimeout(3000)
    const after = (await dialog.innerText()).replace(/\s+/g, ' ')
    log(`after the move: ${after.slice(0, 500)}`)
    await snap('moved')
    if (!after.includes('was chat')) throw new Error('the dialog does not say what it changed from')
    // The Apply bar, on Apps, words it.
    await page.keyboard.press('Escape')
    await page.goto(`${base}/apps`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const bar = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
    const words = bar.match(/open-webui at [a-z0-9-]+/)?.[0] ?? null
    log(`apply bar words: ${words}`)
    await snap('apply-bar')
    if (words !== `open-webui at ${label}`) throw new Error('the Apply bar does not name the move')
    // And back.
    await page.goto(`${base}/c/ai?tab=consumers`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    await page.locator('main nav button[aria-label^="Settings for"]').click()
    await page.waitForTimeout(2500)
    await page.locator('[role="dialog"] button', { hasText: 'as the host says' }).first().click()
    await page.waitForTimeout(3000)
    const back = (await page.locator('[role="dialog"]').innerText()).replace(/\s+/g, ' ')
    log(`after the reset: ${back.slice(0, 400)}`)
    await snap('reset')
    if (back.includes('was chat')) throw new Error('the reset did not put the label back')
  }
  log(`page errors: ${JSON.stringify(errs)}`)
}
