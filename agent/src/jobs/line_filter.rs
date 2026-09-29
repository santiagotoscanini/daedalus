//! A terminal's output as log lines (the Windows holder's filter).

/// What a terminal writes, as log lines: escape sequences removed (CSI,
/// OSC up to BEL or ST, and two-byte escapes), carriage returns taken as
/// line ends (a pseudo-console repaints in place), and the lines the unix
/// filter drops dropped here too — empty ones, and the status box's
/// (opening with `·` or whitespace).
#[derive(Default)]
pub struct LineFilter {
    line: Vec<u8>,
    esc: Esc,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Esc {
    #[default]
    None,
    /// After ESC.
    Start,
    /// Inside `ESC [ …`, until a final byte.
    Csi,
    /// Inside `ESC ] …`, until BEL or ESC \.
    Osc,
    /// ESC inside an OSC: `\` ends it.
    OscEnd,
}

impl LineFilter {
    /// Feed bytes; the whole lines they complete, kept.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.esc {
                Esc::None => match b {
                    0x1b => self.esc = Esc::Start,
                    b'\n' | b'\r' => self.end_line(&mut out),
                    0x07 | 0x08 => {}
                    _ => self.line.push(b),
                },
                Esc::Start => {
                    self.esc = match b {
                        b'[' => Esc::Csi,
                        b']' => Esc::Osc,
                        _ => Esc::None,
                    }
                }
                Esc::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.esc = Esc::None;
                    }
                }
                Esc::Osc => match b {
                    0x07 => self.esc = Esc::None,
                    0x1b => self.esc = Esc::OscEnd,
                    _ => {}
                },
                Esc::OscEnd => self.esc = if b == b'\\' { Esc::None } else { Esc::Osc },
            }
            if self.line.len() > 64 * 1024 {
                self.end_line(&mut out);
            }
        }
        out
    }

    /// What is left when the stream ends.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.end_line(&mut out);
        out
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        let line = String::from_utf8_lossy(&self.line).into_owned();
        self.line.clear();
        let keep = !line.trim().is_empty()
            && !line.starts_with('·')
            && !line.starts_with(|c: char| c.is_whitespace());
        if keep {
            out.push(line);
        }
    }
}
