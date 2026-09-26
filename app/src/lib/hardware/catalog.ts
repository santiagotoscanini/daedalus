// The parts, written down once.
//
// Two kinds of fact about a machine's hardware. What the machine can REPORT
// — board, processor, graphics, memory, drives, the model of a laptop — the
// agent and the host snapshot read from firmware, and this catalog only
// adds what firmware never carries: a photograph and a sentence. What the
// machine cannot report — the case, the cooler, the power supply — nothing
// in a PC will ever say, so those are CHOSEN: on the box, here; on a node,
// on Settings › Machines, from the entries of that kind below.
//
// Every entry is one object holding the photo, the name and the spec, for
// the reason the box's Build tab wrote its parts down in one table: when a
// part is replaced the edit is one entry, and a part whose photo and
// specification live together cannot show last year's cooler beside this
// year's numbers. The list is what this house has bought; a second house
// adds its own. Client-safe on purpose — the views read it directly.

export type PartKind =
  | 'case'
  | 'cooler'
  | 'psu'
  | 'board'
  | 'cpu'
  | 'gpu'
  | 'memory'
  | 'disk'
  | 'machine'

type Photo = { src: string; width: number; height: number }

export type Part = {
  id: string
  kind: PartKind
  name: string
  /** One sentence: what it is and why it was chosen. */
  detail: string
  specs: { k: string; v: string }[]
  photo: Photo | null
  /**
   * How a reported model string is recognised as this part, for the kinds
   * a machine reports. Case-insensitive substrings, any of which matches.
   */
  match?: string[]
  /**
   * For a whole machine that comes in colours: which one this entry is. A
   * laptop reports everything but its colour, so the finish is the one
   * thing its settings ask for, and the entry with the chosen finish is
   * the one drawn.
   */
  finish?: { id: string; name: string }
}

/** The kinds nothing reports, which a machine's settings choose. */
export const CHOSEN_KINDS = ['case', 'cooler', 'psu'] as const
export type ChosenKind = (typeof CHOSEN_KINDS)[number]

const CATALOG: readonly Part[] = [
  // ── cases ──
  {
    id: 'jonsbo-n4',
    kind: 'case',
    name: 'Jonsbo N4',
    detail:
      'Steel and wood, six 3.5" bays. That is why this box is a NAS shape rather than a tower.',
    specs: [
      { k: 'Bays', v: '6 × 3.5" + 2 × 2.5"' },
      { k: 'Board', v: 'ITX / mATX' },
      { k: 'Size', v: '286 × 300 × 228 mm' },
      { k: 'Cooler clearance', v: '70 mm' },
      { k: 'PSU', v: 'SFX, up to 125 mm' },
    ],
    photo: { src: '/part-case-jonsbo-n4.png', width: 700, height: 603 },
  },
  {
    id: 'nzxt-s340',
    kind: 'case',
    name: 'NZXT S340',
    detail:
      'A plain steel mid-tower with a window and no optical bay, from before tempered glass was the default.',
    specs: [
      { k: 'Bays', v: '3 × 3.5" + 2 × 2.5"' },
      { k: 'Board', v: 'ATX / mATX / ITX' },
      { k: 'Slots', v: '7 expansion' },
      { k: 'GPU clearance', v: '364 mm' },
      { k: 'Cooler clearance', v: '161 mm' },
    ],
    photo: { src: '/part-case-nzxt-s340.png', width: 689, height: 868 },
  },
  // ── coolers ──
  {
    id: 'noctua-nh-l9x65',
    kind: 'cooler',
    name: 'Noctua NH-L9x65',
    detail:
      '65 mm tall, chosen against the case’s 70 mm ceiling. The whole build turns on that number.',
    specs: [
      { k: 'Height', v: '65 mm' },
      { k: 'Fan', v: 'NF-A9x14, 92 mm' },
      { k: 'Sockets', v: 'LGA1700 with the kit' },
    ],
    photo: { src: '/part-cooler-noctua-nh-l9x65.png', width: 542, height: 341 },
  },
  {
    id: 'thermalright-phantom-spirit-120-se',
    kind: 'cooler',
    name: 'Thermalright Phantom Spirit 120 SE ARGB',
    detail: 'A dual-tower air cooler that keeps a 7800X3D quiet for the price of a fan.',
    specs: [
      { k: 'Height', v: '154 mm' },
      { k: 'Fans', v: '2 × 120 mm ARGB' },
      { k: 'Heat pipes', v: '7' },
      { k: 'Socket', v: 'AM5' },
    ],
    photo: { src: '/part-cooler-thermalright-phantom-spirit-120-se.png', width: 700, height: 700 },
  },
  // ── power supplies ──
  {
    id: 'evga-supernova-650-gm',
    kind: 'psu',
    name: 'EVGA SuperNOVA 650 GM',
    detail: 'SFX, 80+ Gold, fully modular. The case dictates the form factor.',
    specs: [
      { k: 'Power', v: '650 W' },
      { k: 'Form', v: 'SFX' },
      { k: 'Rating', v: '80+ Gold' },
      { k: 'Cables', v: 'fully modular' },
    ],
    // scan.co.uk refuses this house; the photo waits for a source that answers.
    photo: null,
  },
  {
    id: 'msi-mpg-a1000g-pcie5',
    kind: 'psu',
    name: 'MSI MPG A1000G PCIE5',
    detail: 'ATX 3.0 with a native 16-pin PCIe 5 lead, sized for a 7900 XTX with room to spare.',
    specs: [
      { k: 'Power', v: '1000 W' },
      { k: 'Form', v: 'ATX 3.0' },
      { k: 'Rating', v: '80+ Gold' },
      { k: 'Cables', v: 'fully modular, 12VHPWR' },
    ],
    photo: { src: '/part-psu-msi-mpg-a1000g.png', width: 875, height: 700 },
  },
  // ── boards ──
  {
    id: 'msi-pro-b760m-p-ddr4',
    kind: 'board',
    name: 'MSI PRO B760M-P DDR4',
    detail:
      'A plain mATX board with the DDR4 slots the memory already owned; MS-7E02 to its firmware.',
    specs: [
      { k: 'Chipset', v: 'Intel B760' },
      { k: 'Socket', v: 'LGA1700' },
      { k: 'Memory', v: '4 × DDR4, 128 GB' },
      { k: 'M.2', v: '2' },
      { k: 'Form', v: 'mATX' },
    ],
    photo: { src: '/part-board-msi-b760m-p.png', width: 900, height: 720 },
    match: ['B760M-P', 'MS-7E02'],
  },
  {
    id: 'gigabyte-b650-aorus-elite-ax',
    kind: 'board',
    name: 'Gigabyte B650 AORUS ELITE AX',
    detail:
      'Revision 1.2: the same board as the first, with the firmware line that tells them apart.',
    specs: [
      { k: 'Chipset', v: 'AMD B650' },
      { k: 'Socket', v: 'AM5' },
      { k: 'Memory', v: '4 × DDR5, 192 GB' },
      { k: 'M.2', v: '3, one PCIe 5' },
      { k: 'Form', v: 'ATX' },
      { k: 'Wireless', v: 'Wi-Fi 6E, Bluetooth 5.3' },
    ],
    photo: { src: '/part-board-gigabyte-b650-elite-ax.png', width: 900, height: 675 },
    match: ['B650 AORUS ELITE AX'],
  },
  // ── processors ──
  {
    id: 'intel-i5-12600k',
    kind: 'cpu',
    name: 'Intel Core i5-12600K',
    detail:
      'Six performance cores and four efficiency cores, with the integrated graphics that transcode for the house.',
    specs: [
      { k: 'Cores', v: '6P + 4E, 16 threads' },
      { k: 'Boost', v: '4.9 GHz' },
      { k: 'Graphics', v: 'UHD 770' },
    ],
    photo: { src: '/part-cpu-i5-12600k.png', width: 786, height: 587 },
    match: ['i5-12600K'],
  },
  {
    id: 'amd-ryzen-7-7800x3d',
    kind: 'cpu',
    name: 'AMD Ryzen 7 7800X3D',
    detail: 'Eight cores under 96 MB of stacked cache, which is what games want.',
    specs: [
      { k: 'Cores', v: '8, 16 threads' },
      { k: 'Boost', v: '5.0 GHz' },
      { k: 'Cache', v: '96 MB L3' },
    ],
    photo: { src: '/part-cpu-ryzen-7800x3d.png', width: 900, height: 900 },
    match: ['7800X3D'],
  },
  // ── graphics ──
  {
    id: 'amd-radeon-rx-7900-xtx',
    kind: 'gpu',
    name: 'AMD Radeon RX 7900 XTX',
    detail: '24 GB of memory on a reference card, which is also the model server Lemonade runs on.',
    specs: [
      { k: 'Memory', v: '24 GB GDDR6' },
      { k: 'Compute units', v: '96' },
      { k: 'Power', v: '355 W' },
    ],
    photo: { src: '/part-gpu-rx-7900-xtx.png', width: 700, height: 700 },
    match: ['7900 XTX', '7900XTX'],
  },
  // ── memory ──
  {
    id: 'corsair-vengeance-lpx-64',
    kind: 'memory',
    name: 'Corsair Vengeance LPX',
    detail:
      'Low-profile heat spreaders, which on a board this small is the specification that matters. A tall kit fouls the cooler.',
    specs: [
      { k: 'Kit', v: '2 × 32 GB DDR4' },
      { k: 'Speed', v: '3200 MT/s, CL16' },
    ],
    photo: { src: '/part-ram-vengeance-lpx.png', width: 700, height: 256 },
    match: ['CMK64GX4M2E3200C16', 'Vengeance LPX'],
  },
  {
    id: 'tforce-delta-rgb-ddr5-32',
    kind: 'memory',
    name: 'T-Force Delta RGB DDR5',
    detail: 'A 7200 MT/s kit the board runs at its EXPO profile.',
    specs: [
      { k: 'Kit', v: '2 × 16 GB DDR5' },
      { k: 'Speed', v: '7200 MT/s, CL34' },
    ],
    photo: { src: '/part-ram-tforce-delta-ddr5.png', width: 700, height: 700 },
    // SMBIOS spells the kit "UD5-7200": Team's DDR5 part family, not the SKU.
    match: ['FF3D532G7200HC34ADC01', 'UD5-7200', 'T-Force', 'TEAMGROUP'],
  },
  // ── drives ──
  {
    id: 'crucial-t700-4tb',
    kind: 'disk',
    name: 'Crucial T700 4 TB',
    detail: 'A PCIe 5 drive under its own heatsink; the only drive in the machine.',
    specs: [
      { k: 'Interface', v: 'PCIe 5.0 x4' },
      { k: 'Read', v: '12,400 MB/s' },
    ],
    photo: { src: '/part-disk-crucial-t700.png', width: 642, height: 493 },
    match: ['CT4000T700SSD3', 'T700'],
  },
  // ── whole machines ──
  {
    id: 'macbook-pro-14-m3-pro-space-black',
    kind: 'machine',
    name: 'MacBook Pro 14" (M3 Pro)',
    detail: 'Space Black, 18 GB of unified memory. The laptop the house is worked on from.',
    specs: [
      { k: 'Chip', v: 'Apple M3 Pro' },
      { k: 'Memory', v: '18 GB unified' },
      { k: 'Identifier', v: 'Mac15,7' },
    ],
    photo: { src: '/part-mac-macbook-pro-m3-space-black.png', width: 900, height: 900 },
    match: ['Mac15,7'],
    finish: { id: 'space-black', name: 'Space Black' },
  },
  {
    id: 'macbook-pro-14-m3-pro-silver',
    kind: 'machine',
    name: 'MacBook Pro 14" (M3 Pro)',
    detail: 'Silver, 18 GB of unified memory.',
    specs: [
      { k: 'Chip', v: 'Apple M3 Pro' },
      { k: 'Memory', v: '18 GB unified' },
      { k: 'Identifier', v: 'Mac15,7' },
    ],
    photo: null,
    match: ['Mac15,7'],
    finish: { id: 'silver', name: 'Silver' },
  },
]

export function partById(id: string | null | undefined): Part | null {
  if (id == null) return null
  return CATALOG.find((p) => p.id === id) ?? null
}

/** The catalog entries a machine may choose for a kind nothing reports. */
export function partsOfKind(kind: PartKind): Part[] {
  return CATALOG.filter((p) => p.kind === kind)
}

/**
 * The entry a reported model string names, when the catalog knows it. For a
 * machine that comes in colours, the entry with the chosen finish — or the
 * first, when none was chosen.
 */
export function partMatching(
  kind: PartKind,
  model: string | null | undefined,
  finish?: string | null,
): Part | null {
  if (model == null || model === '') return null
  const m = model.toLowerCase()
  const hits = CATALOG.filter(
    (p) => p.kind === kind && p.match?.some((s) => m.includes(s.toLowerCase())) === true,
  )
  if (hits.length === 0) return null
  const chosen = finish == null ? undefined : hits.find((p) => p.finish?.id === finish)
  return chosen ?? hits[0] ?? null
}

/** The finishes a reported machine comes in, for its settings to offer. */
export function finishesFor(model: string | null | undefined): { id: string; name: string }[] {
  if (model == null || model === '') return []
  const m = model.toLowerCase()
  return CATALOG.filter(
    (p) =>
      p.kind === 'machine' &&
      p.finish !== undefined &&
      p.match?.some((s) => m.includes(s.toLowerCase())) === true,
  ).map((p) => p.finish as { id: string; name: string })
}

/** Whether an id names a finish some machine in the catalog comes in. */
export function isFinish(id: unknown): id is string {
  return typeof id === 'string' && CATALOG.some((p) => p.finish?.id === id)
}

/** Whether an id names a part of the kind a setting may choose. */
export function isChosenPart(kind: ChosenKind, id: unknown): id is string {
  return typeof id === 'string' && CATALOG.some((p) => p.kind === kind && p.id === id)
}
