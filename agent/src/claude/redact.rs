//! The one line of conversation the roster carries — a transcript's last
//! prompt — made safe to leave the machine as far as shape allows: one line,
//! credential shapes replaced, cut to 160 characters, in that order (a cut
//! first could leave half a token where the pattern would have taken it
//! all).
//!
//! The patterns are the box snapshot's, which were the app's
//! `lib/redact.ts` plus the API-key prefixes that file had no reason to
//! carry, hand-written here because the agent carries no regex engine. Each
//! rule is a scanner that, at a position, says how far a match runs and how
//! much of its start is kept; the rules run one after another over the whole
//! text, leftmost and non-overlapping, as a chain of `gsub`s does.
//!
//! BEST EFFORT, and nothing more: a secret with no shape — a password, a
//! passphrase, a bare hex string, a sentence about something private — is
//! not recognisable and stays, up to the 160 characters. The operator took
//! that trade for the snapshot; the roster keeps it and no more.

/// The longest a label or a prompt is, in characters, the ellipsis included.
pub const CLAMP: usize = 160;

/// Whitespace runs as one space, trimmed.
pub fn oneline(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `CLAMP` characters: 159 and an ellipsis when longer.
pub fn clamp(s: &str) -> String {
    if s.chars().count() > CLAMP {
        let mut out: String = s.chars().take(CLAMP - 1).collect();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

/// A prompt as the roster carries it: one line, redacted, clamped.
pub fn prompt(s: &str) -> Option<String> {
    let s = clamp(&redact(&oneline(s)));
    (!s.is_empty()).then_some(s)
}

const MARK: &str = "[redacted]";

/// A match at a position: where it ends, and how many characters of its
/// start stay as they are (a URL's scheme and user, a header's name).
type Rule = fn(&[char], usize) -> Option<(usize, usize)>;

/// Every credential shape, replaced (module doc).
pub fn redact(s: &str) -> String {
    const RULES: &[Rule] = &[
        pem,
        github_pat,
        github_token,
        jwt,
        sk_key,
        aws_key,
        slack_token,
        google_key,
        access_token,
        url_password,
        auth_value,
    ];
    let mut text = s.to_string();
    for rule in RULES {
        text = apply(&text, *rule);
    }
    text
}

fn apply(s: &str, rule: Rule) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        match rule(&c, i) {
            Some((end, keep)) if end > i => {
                out.extend(&c[i..i + keep]);
                out.push_str(MARK);
                i = end;
            }
            _ => {
                out.push(c[i]);
                i += 1;
            }
        }
    }
    out
}

fn at(c: &[char], i: usize, lit: &str) -> bool {
    (i..).zip(lit.chars()).all(|(j, l)| c.get(j) == Some(&l))
}

fn at_ci(c: &[char], i: usize, lit: &str) -> bool {
    (i..)
        .zip(lit.chars())
        .all(|(j, l)| c.get(j).is_some_and(|x| x.eq_ignore_ascii_case(&l)))
}

/// How many characters from `i` satisfy `ok`.
fn run(c: &[char], i: usize, ok: impl Fn(char) -> bool) -> usize {
    c[i.min(c.len())..].iter().take_while(|x| ok(**x)).count()
}

fn word(x: char) -> bool {
    x.is_ascii_alphanumeric() || x == '_'
}

fn word_dash(x: char) -> bool {
    word(x) || x == '-'
}

/// `-----BEGIN … PRIVATE KEY[ BLOCK]-----` through its `-----END …-----`, or
/// to the end when there is none.
fn pem(c: &[char], i: usize) -> Option<(usize, usize)> {
    if !at(c, i, "-----BEGIN ") {
        return None;
    }
    let j = i + 11;
    let n = run(c, j, |x| {
        x.is_ascii_uppercase() || x.is_ascii_digit() || x == ' '
    });
    // `[A-Z0-9 ]*` is greedy and backs off to the last place the tail fits.
    let tail = (0..=n).rev().find_map(|k| {
        let p = j + k;
        ["PRIVATE KEY BLOCK-----", "PRIVATE KEY-----"]
            .iter()
            .find(|t| at(c, p, t))
            .map(|t| p + t.chars().count())
    })?;
    let mut k = tail;
    while k < c.len() {
        if at(c, k, "-----END ") {
            let m = k + 9;
            let r = run(c, m, |x| {
                x.is_ascii_uppercase() || x.is_ascii_digit() || x == ' '
            });
            // `[A-Z0-9 ]*-----`: the dashes right after the run, or backed
            // off into it (never: the run holds no dash).
            if at(c, m + r, "-----") {
                return Some((m + r + 5, 0));
            }
        }
        k += 1;
    }
    Some((c.len(), 0))
}

fn prefixed(c: &[char], i: usize, prefix: &str, ok: fn(char) -> bool, min: usize) -> Option<usize> {
    if !at(c, i, prefix) {
        return None;
    }
    let j = i + prefix.chars().count();
    let n = run(c, j, ok);
    (n >= min).then_some(j + n)
}

/// `github_pat_[A-Za-z0-9_]+`
fn github_pat(c: &[char], i: usize) -> Option<(usize, usize)> {
    prefixed(c, i, "github_pat_", word, 1).map(|e| (e, 0))
}

/// `gh[opusr]_[A-Za-z0-9_]{20,}`
fn github_token(c: &[char], i: usize) -> Option<(usize, usize)> {
    if !(at(c, i, "gh") && matches!(c.get(i + 2), Some('o' | 'p' | 'u' | 's' | 'r'))) {
        return None;
    }
    prefixed(c, i + 3, "_", word, 20).map(|e| (e, 0))
}

/// `(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`
fn jwt(c: &[char], i: usize) -> Option<(usize, usize)> {
    if i > 0 && word_dash(c[i - 1]) {
        return None;
    }
    let a = prefixed(c, i, "eyJ", word_dash, 8)?;
    let b = prefixed(c, a, ".", word_dash, 8)?;
    let e = prefixed(c, b, ".", word_dash, 0)?;
    Some((e, 0))
}

/// `sk-(?:ant-)?[A-Za-z0-9_-]{16,}` — the optional part is inside the run's
/// own class, so it is the run alone.
fn sk_key(c: &[char], i: usize) -> Option<(usize, usize)> {
    prefixed(c, i, "sk-", word_dash, 16).map(|e| (e, 0))
}

/// `AKIA[0-9A-Z]{16}`
fn aws_key(c: &[char], i: usize) -> Option<(usize, usize)> {
    if !at(c, i, "AKIA") {
        return None;
    }
    let n = run(c, i + 4, |x| x.is_ascii_digit() || x.is_ascii_uppercase());
    (n >= 16).then_some((i + 4 + 16, 0))
}

/// `xox[baprs]-[A-Za-z0-9-]{10,}`
fn slack_token(c: &[char], i: usize) -> Option<(usize, usize)> {
    if !(at(c, i, "xox") && matches!(c.get(i + 3), Some('b' | 'a' | 'p' | 'r' | 's'))) {
        return None;
    }
    prefixed(c, i + 4, "-", |x| x.is_ascii_alphanumeric() || x == '-', 10).map(|e| (e, 0))
}

/// `AIza[0-9A-Za-z_-]{35}`
fn google_key(c: &[char], i: usize) -> Option<(usize, usize)> {
    if !at(c, i, "AIza") {
        return None;
    }
    (run(c, i + 4, word_dash) >= 35).then_some((i + 4 + 35, 0))
}

/// `x-access-token:[^@\s]+` → `x-access-token:[redacted]`
fn access_token(c: &[char], i: usize) -> Option<(usize, usize)> {
    let lit = "x-access-token:";
    let e = prefixed(c, i, lit, |x| x != '@' && !x.is_whitespace(), 1)?;
    Some((e, lit.len()))
}

/// `(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*://[^\s:@/]*:[^\s/]+@`, any case:
/// the scheme and user stay, the password goes, the `@` stays.
fn url_password(c: &[char], i: usize) -> Option<(usize, usize)> {
    let scheme = |x: char| x.is_ascii_alphanumeric() || matches!(x, '+' | '.' | '-');
    if !c[i].is_ascii_alphabetic() || (i > 0 && scheme(c[i - 1])) {
        return None;
    }
    let s = i + 1 + run(c, i + 1, scheme);
    if !at(c, s, "://") {
        return None;
    }
    let u = s + 3;
    let user = run(c, u, |x| {
        !x.is_whitespace() && !matches!(x, ':' | '@' | '/')
    });
    let colon = u + user;
    if c.get(colon) != Some(&':') {
        return None;
    }
    let p = colon + 1;
    let pass = run(c, p, |x| !x.is_whitespace() && x != '/');
    // `[^\s/]+@` is greedy: the LAST `@` in the run, with something before it.
    let at_sign = (1..pass).rev().map(|k| p + k).find(|k| c[*k] == '@')?;
    Some((at_sign, p - i))
}

/// `(authorization|_authToken)["']?\s*[:=]\s*["']?(basic |bearer |token )?[^\s"',;]+`,
/// any case: everything up to the value stays.
fn auth_value(c: &[char], i: usize) -> Option<(usize, usize)> {
    let name = ["authorization", "_authtoken"]
        .iter()
        .find(|n| at_ci(c, i, n))?;
    let mut j = i + name.len();
    if matches!(c.get(j), Some('"' | '\'')) {
        j += 1;
    }
    j += run(c, j, char::is_whitespace);
    if !matches!(c.get(j), Some(':' | '=')) {
        return None;
    }
    j += 1;
    j += run(c, j, char::is_whitespace);
    if matches!(c.get(j), Some('"' | '\'')) {
        j += 1;
    }
    let value = |x: char| !x.is_whitespace() && !matches!(x, '"' | '\'' | ',' | ';');
    // The scheme word is optional; it is kept only when a value follows it.
    for scheme in ["basic ", "bearer ", "token "] {
        if at_ci(c, j, scheme) {
            let v = j + scheme.len();
            let n = run(c, v, value);
            if n > 0 {
                return Some((v + n, v - i));
            }
        }
    }
    let n = run(c, j, value);
    (n > 0).then_some((j + n, j - i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_is_one_line_redacted_then_cut() {
        assert_eq!(oneline("  fix\n\tthe   build \n"), "fix the build");
        assert_eq!(prompt("   "), None);
        let long = "a".repeat(200);
        let p = prompt(&long).unwrap();
        assert_eq!(p.chars().count(), 160);
        assert!(p.ends_with('…'));
        // Redaction first: a token past the cut is still taken whole.
        let t = format!("{} ghp_{}", "x".repeat(150), "A".repeat(30));
        assert_eq!(
            prompt(&t).unwrap(),
            clamp(&format!("{} [redacted]", "x".repeat(150)))
        );
    }

    #[test]
    fn every_shape_is_taken() {
        let cases = [
            (
                "key -----BEGIN OPENSSH PRIVATE KEY----- abc -----END OPENSSH PRIVATE KEY----- after",
                "key [redacted] after",
            ),
            ("-----BEGIN RSA PRIVATE KEY----- unterminated", "[redacted]"),
            (
                "-----BEGIN PGP PRIVATE KEY BLOCK----- x -----END PGP PRIVATE KEY BLOCK-----",
                "[redacted]",
            ),
            ("-----BEGIN PUBLIC KEY----- x", "-----BEGIN PUBLIC KEY----- x"),
            ("use github_pat_11AB_cd now", "use [redacted] now"),
            (&format!("t ghp_{} x", "a".repeat(20)), "t [redacted] x"),
            (&format!("t ghx_{}", "a".repeat(20)), &format!("t ghx_{}", "a".repeat(20))),
            ("ghp_short", "ghp_short"),
            ("bearer eyJhbGciOiJ.eyJzdWIiOiJ4.sig-_x ok", "bearer [redacted] ok"),
            ("xeyJhbGciOiJ.eyJzdWIiOiJ4.sig", "xeyJhbGciOiJ.eyJzdWIiOiJ4.sig"),
            (
                "sk-ant-api03-abcdefghijklmnop end",
                "[redacted] end",
            ),
            ("sk-short", "sk-short"),
            ("AKIAABCDEFGHIJKLMNOP!", "[redacted]!"),
            ("xoxb-1234567890-abc", "[redacted]"),
            (&format!("AIza{}", "B".repeat(35)), "[redacted]"),
            (
                "https://x-access-token:ghs_secret@github.com/a",
                "https://x-access-token:[redacted]@github.com/a",
            ),
            (
                "git clone https://ana:hunter2@example.com/repo",
                "git clone https://ana:[redacted]@example.com/repo",
            ),
            (
                "postgres://u:p@ss@db:5432/x",
                "postgres://u:[redacted]@db:5432/x",
            ),
            ("https://example.com/a:b@c", "https://example.com/a:b@c"),
            (
                "Authorization: Bearer abc.def, next",
                "Authorization: Bearer [redacted], next",
            ),
            ("\"_authToken\"=\"npm_x\"", "\"_authToken\"=\"[redacted]\""),
            ("authorization=token", "authorization=[redacted]"),
            ("the authorization flow", "the authorization flow"),
        ];
        for (input, want) in cases {
            assert_eq!(redact(input), want, "{input}");
        }
    }
}
