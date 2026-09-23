export default async ({ page, snap, log }) => {
  const base = 'http://app-daedalus:3000'
  await page.setExtraHTTPHeaders({
    'x-forwarded-email': process.env.LAB_EMAIL ?? 'operator@example.com',
    'x-forwarded-groups': '["admins"]',
  })
  await page.setViewportSize({ width: 1440, height: 1700 })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|vite\]|frame-ancestors/.test(m.text()))
      errs.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => {
    if (!/WebSocket/.test(String(e))) errs.push(`pageerror ${String(e).slice(0, 200)}`)
  })
  const walk = [
    ['providers-default', '/c/ai?tab=providers'],
    ['providers-box', '/c/ai?tab=providers&machine=box'],
    ['providers-node', `/c/ai?tab=providers&machine=${process.env.LAB_NODE ?? ''}`],
    ['gateway', '/c/ai?tab=gateway'],
    ['consumers', '/c/ai?tab=consumers'],
    ['alias-lemonade', '/c/ai?tab=lemonade'],
  ]
  for (const [name, path] of walk) {
    const t0 = Date.now()
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('main nav a[aria-current="page"]')]
        .map((a) => a.textContent.trim())
        .join('|'),
    )
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('main h2, main h3')]
        .map((h) => h.textContent.trim())
        .join(' | '),
    )
    const text = await page.evaluate(
      () => document.querySelector('main')?.innerText?.slice(0, 1400) ?? '',
    )
    log(`${name}: ${Date.now() - t0}ms active=[${tabs}]\nboards=[${heads}]\n${text}\n----`)
    await snap(name)
  }

  // The picker, by CLICKING it rather than by typing its URL. The two are
  // not the same assertion: the pills once compared the URL's machine-and-
  // kind against a machine alone, so nothing ever read as picked and every
  // click appeared to do nothing — which a walk of URLs cannot see.
  await page.goto(`${base}/c/ai?tab=providers`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  const picker = 'nav[aria-label="Provider machine"] a'
  const names = await page.$$eval(picker, (as) => as.map((a) => a.textContent.trim()))
  const lit = () =>
    page.$$eval(picker, (as) =>
      as.filter((a) => a.className.includes('border-primary')).map((a) => a.textContent.trim()),
    )
  log(`picker: ${names.length} machines [${names.join(' · ')}] lit=[${(await lit()).join('|')}]`)
  if ((await lit()).length !== 1) throw new Error('exactly one machine should read as picked')

  for (let i = 0; i < names.length; i++) {
    await page.$$eval(picker, (as, n) => as[n].click(), i)
    await page.waitForTimeout(3500)
    const head = await page.$eval('main h2', (h) => h.textContent.trim())
    const picked = await lit()
    log(`click ${i} -> head=[${head}] lit=[${picked.join('|')}]`)
    if (picked.length !== 1) throw new Error(`click ${i}: ${picked.length} pills lit`)
    if (!picked[0].startsWith(head)) throw new Error(`click ${i}: ${head} lit as ${picked[0]}`)
    await snap(`pick-${i}`)
  }
  log(`console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 5))}`)
}
