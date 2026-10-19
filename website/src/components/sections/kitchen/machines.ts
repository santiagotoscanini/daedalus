/** The kitchen's six machines as data: what each is called, where it stands, what it does for the
 * house and the mark it carries. The wide drawing reads it for its readout and each machine's
 * accessible name; the phone version prints it as a list. The sentences are built from the story's
 * room table: "{Machine} in the {room}." then the role, so nothing is welded with middots. */

export type MachineId = "box" | "macbook" | "laptop" | "gaming" | "oldpc" | "iphone";

/** The mark shown beside a machine's name. The box has none of the brands', so it gets its own
 * small drawing of itself. */
export type Os = "box" | "apple" | "windows" | "linux";

export interface Machine {
  id: MachineId;
  /** The list's first line. */
  name: string;
  /** The list's right column. */
  room: string;
  /** The readout's lead, set in ink-1. */
  lead: string;
  /** The readout's second sentence, in ink-3. */
  role: string;
  /** What this machine does next, not yet: shown on its own line behind the coming mark. */
  next?: string;
  os: Os;
}

export const MACHINES: Record<MachineId, Machine> = {
  box: {
    id: "box",
    name: "The box",
    room: "Kitchen",
    lead: "The box in the kitchen.",
    role: "Runs the family’s apps and keeps their data.",
    os: "box",
  },
  macbook: {
    id: "macbook",
    name: "Personal MacBook",
    room: "Study",
    lead: "Personal MacBook in the study.",
    role: "Joins with the Mac app.",
    next: "Next: it builds the family’s iPhone apps.",
    os: "apple",
  },
  laptop: {
    id: "laptop",
    name: "Work laptop",
    room: "Home office",
    lead: "Work laptop in the home office.",
    role: "Reports its updates and free space to the box.",
    os: "windows",
  },
  gaming: {
    id: "gaming",
    name: "Gaming PC",
    room: "Upstairs",
    lead: "Gaming PC upstairs.",
    role: "Runs AI models on its graphics card.",
    os: "windows",
  },
  oldpc: {
    id: "oldpc",
    name: "Old PC",
    room: "Closet",
    lead: "Old PC in the closet.",
    role: "Joins like the rest. Erased, it could become the box.",
    os: "linux",
  },
  iphone: {
    id: "iphone",
    name: "Your iPhone",
    room: "Living room",
    lead: "Your iPhone in the living room.",
    role: "Where you ask from.",
    os: "apple",
  },
};

/** The phone list walks the house from the box outwards: kitchen, study, home office, upstairs,
 * closet, living room. */
export const LIST_ORDER: readonly MachineId[] = ["box", "macbook", "laptop", "gaming", "oldpc", "iphone"];

/** The whole readout as one sentence run, for a machine's accessible name. */
export function readout(m: Machine): string {
  return m.next ? `${m.lead} ${m.role} ${m.next}` : `${m.lead} ${m.role}`;
}
