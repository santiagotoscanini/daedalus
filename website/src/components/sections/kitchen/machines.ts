/** The kitchen's six machines as data: where each stands, what it does for the house and the mark it
 * carries. The wide drawing reads it for its readout and each machine's accessible name; the phone
 * version prints it as a list. The sentences are built from the story's room table: "{Machine} in
 * the {room}." then the role, so nothing is welded with middots. The room is only ever said inside
 * the sentence, never as a tag of its own: the phone's drawing is cropped to the kitchen, and a
 * label for a room the reader cannot see would point at nothing. */

export type MachineId = "box" | "macbook" | "laptop" | "gaming" | "oldpc" | "iphone";

/** The mark shown beside a machine's name. The box has none of the brands', so it gets its own
 * small drawing of itself. */
export type Os = "box" | "apple" | "windows" | "linux";

export interface Machine {
  id: MachineId;
  /** The readout's and the list's first line, set in ink-1. */
  lead: string;
  /** The second sentence, in ink-3. */
  role: string;
  /** What this machine does next, not yet: shown on its own line behind the coming mark. */
  next?: string;
  os: Os;
}

export const MACHINES: Record<MachineId, Machine> = {
  box: {
    id: "box",
    lead: "The box in the kitchen.",
    role: "Runs the family’s apps and keeps their data.",
    os: "box",
  },
  macbook: {
    id: "macbook",
    lead: "Personal MacBook in the study.",
    role: "Joins with the Mac app.",
    next: "Next: it builds the family’s iPhone apps.",
    os: "apple",
  },
  laptop: {
    id: "laptop",
    lead: "Work laptop in the home office.",
    role: "Reports its updates and free space to the box.",
    os: "windows",
  },
  gaming: {
    id: "gaming",
    lead: "Gaming PC upstairs.",
    role: "Runs AI models on its graphics card.",
    os: "windows",
  },
  oldpc: {
    id: "oldpc",
    lead: "Old PC in the closet.",
    role: "Joins like the rest. Erased, it could become the box.",
    os: "linux",
  },
  iphone: {
    id: "iphone",
    lead: "Your iPhone in the living room.",
    role: "Where you ask from.",
    os: "apple",
  },
};

/** What the drawing says once the break in the internet cable has played and nobody is pointing at
 * a machine: the paragraph's claim about outages, in the one caption slot. The wide drawing's
 * readout shows it; the phone's drawing carries it as a caption under it. */
export const OUTAGE = {
  lead: "The internet is out.",
  role: "The box and the family’s apps are still on.",
  os: "box",
} as const satisfies { lead: string; role: string; os: Os };

/** The phone list walks the house from the box outwards: kitchen, study, home office, upstairs,
 * closet, living room. */
export const LIST_ORDER: readonly MachineId[] = ["box", "macbook", "laptop", "gaming", "oldpc", "iphone"];

/** The whole readout as one sentence run, for a machine's accessible name. */
export function readout(m: Machine): string {
  return m.next ? `${m.lead} ${m.role} ${m.next}` : `${m.lead} ${m.role}`;
}
