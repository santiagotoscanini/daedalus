/** An iPhone 16 Pro seen from the front, 330 x 690 CSS px: the hero's two devices. The proportions
 * are the real phone's (71.5 x 149.6 mm), and every radius is concentric: a 2.5px titanium band at 55,
 * the black bezel at 52.5, the screen at 43. On top of whatever screen it holds it draws what iOS
 * draws over every app: the status bar, the Dynamic Island and the home indicator.
 *
 * The finish decides the inks too, because each phone shows one kind of screen: your Black Titanium
 * phone is in dark mode (white glyphs), Grandma's Desert Titanium one shows her light Home Screen and
 * Pinch (near-black glyphs). Styles: styles/landing/hero.css, `.iphone*`. */

import type { ReactNode } from "react";

export type Finish = "black" | "desert";

/** The iOS status bar: 9:41 centred in the left ear, cellular, Wi-Fi and a full battery centred in
 * the right one, all on the island's centre line. Drawn on a 0.5px grid so every edge is whole at 2x. */
function StatusBar() {
  return (
    <div className="iphone-status">
      <span className="iphone-time">9:41</span>
      <span className="iphone-glyphs">
        {/* cellular: four bars, 3 wide, 1 apart */}
        <svg width="15" height="9.5" viewBox="0 0 15 9.5" fill="currentColor">
          <rect x="0" y="6" width="3" height="3.5" rx="0.75" />
          <rect x="4" y="4" width="3" height="5.5" rx="0.75" />
          <rect x="8" y="2" width="3" height="7.5" rx="0.75" />
          <rect x="12" y="0" width="3" height="9.5" rx="0.75" />
        </svg>
        {/* Wi-Fi: two bands and a wedge on one centre, a 90 degree fan */}
        <svg width="13.5" height="9.5" viewBox="0 0 13.5 9.5" fill="currentColor">
          <path d="M.1 2.85A9.4 9.4 0 0 1 13.4 2.85L11.84 4.41A7.2 7.2 0 0 0 1.66 4.41Z" />
          <path d="M2.58 5.33A5.9 5.9 0 0 1 10.92 5.33L9.37 6.88A3.7 3.7 0 0 0 4.13 6.88Z" />
          <path d="M5.05 7.8A2.4 2.4 0 0 1 8.45 7.8L6.75 9.5Z" />
        </svg>
        {/* battery, full: a 35% outline, the charge inset 1.5, the cap at 40% */}
        <svg width="22.5" height="10.5" viewBox="0 0 22.5 10.5">
          <rect x="0.5" y="0.5" width="19.5" height="9.5" rx="2.75" fill="none" stroke="currentColor" strokeOpacity=".35" />
          <rect x="2" y="2" width="16.5" height="6.5" rx="1.5" fill="currentColor" />
          <path d="M21 3.5v3.5a1.9 1.9 0 0 0 0-3.5Z" fill="currentColor" fillOpacity=".4" />
        </svg>
      </span>
    </div>
  );
}

export function IPhone({ finish, children }: { finish: Finish; children: ReactNode }) {
  return (
    <div className={`iphone iphone-${finish}`}>
      {/* the buttons sit behind the band, so only the 2.5px that stands proud of it shows */}
      <span className="iphone-key iphone-key-action" />
      <span className="iphone-key iphone-key-up" />
      <span className="iphone-key iphone-key-down" />
      <span className="iphone-key iphone-key-side" />
      <span className="iphone-key iphone-key-camera" />
      <div className="iphone-body">
        <div className="iphone-bezel">
          <div className="iphone-screen">
            {children}
            <StatusBar />
            <span className="iphone-island" />
            <span className="iphone-home" />
          </div>
        </div>
      </div>
    </div>
  );
}
