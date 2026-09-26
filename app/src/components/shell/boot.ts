// Two inline scripts the document runs before the first paint.
//
// The shell is server-rendered, and two preferences live only in the
// browser. Reading either in an effect would paint the server's guess first
// and then swap — a visible flash on every load. So each is a tiny script in
// <head> that sets an attribute on <html>, and the stylesheet keys off it.

/**
 * The collapsed/expanded rail. The attribute is what the `nav-collapsed:`
 * variant (app.css) and `--sidebar-w` (theme.css) key off, so setting it here
 * means the very first paint is already right.
 */
export const NAV_BOOT = `try{var v=localStorage.getItem('daedalus:nav');if(v==='collapsed')document.documentElement.dataset.nav=v}catch(e){}`

/**
 * Resolving the `system` scheme to a real one.
 *
 * The other two schemes need no script: the operator's choice is a database
 * row, so the server already renders it onto `<html>`. `system` is the one
 * the server cannot answer — the OS preference lives in the browser.
 *
 * This covers the moment BEFORE hydration only. From hydration on,
 * `useResolvedScheme` (lib/scheme.ts) answers the same question inside
 * React, so the attribute React renders agrees with the one this wrote —
 * otherwise React's next pass put the server's guess back, and a light
 * system went dark on the first click.
 *
 * Deliberately not a `prefers-color-scheme` media query in the CSS: an
 * operator who picks light on a dark-mode laptop must get light, and two
 * mechanisms voting on the same attribute is how a theme toggle stops
 * working.
 */
export const THEME_BOOT = `try{if(document.documentElement.dataset.themeSource==='system')document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch(e){}`
