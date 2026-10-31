//! Making engine failure text fit to show. Stderr can hold terminal codes and, when a
//! CLI dumps a request, credentials. A line that looks like a secret is dropped whole,
//! because telling what part of it is the secret is guesswork.

const HIDDEN_LINE: &str = "[a line was hidden because it may hold a credential]";

/// Text that names a credential by key, in lower case.
const KEYED: &[&str] = &[
    "authorization:",
    "bearer ",
    "cookie:",
    "-----begin",
    "api_key=",
    "api_key:",
    "api-key:",
    "api-key=",
    "apikey=",
    "apikey:",
    "password=",
    "password:",
    "passwd=",
    "secret=",
    "secret:",
    "token=",
    "token:",
];

/// How vendors start their tokens.
const PREFIXES: &[&str] = &[
    "sk-",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "eyJ",
    "AKIA",
];

const MIN_OPAQUE_CHARS: usize = 32;

/// Removes escape sequences: CSI (`ESC [ ... letter`), OSC (`ESC ] ... BEL` or `ESC \`)
/// and any other two-byte sequence.
fn strip_ansi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            plain.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(code) = chars.next() {
                    if code == '\u{7}' {
                        break;
                    }
                    if code == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    plain
}

fn is_uuid(word: &str) -> bool {
    let parts: Vec<&str> = word.split('-').collect();
    parts.iter().map(|part| part.len()).eq([8, 4, 4, 4, 12])
        && word.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

/// A long unbroken mix of letters and digits, which prose and paths are not. A path
/// separator alone does not clear it, since base64 uses `/` too, so a word with more
/// than one is taken for a path.
fn is_opaque(word: &str) -> bool {
    if word.chars().count() < MIN_OPAQUE_CHARS || is_uuid(word) {
        return false;
    }
    let token_chars = word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_+=-/.".contains(c));
    let separators = word.chars().filter(|c| *c == '/').count();
    token_chars
        && separators < 2
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic())
}

fn looks_secret(line: &str) -> bool {
    let lower = line.to_lowercase();
    KEYED.iter().any(|key| lower.contains(key))
        || line
            .split(|c: char| c.is_whitespace() || "=:\"'`,;()[]{}<>".contains(c))
            .any(|word| PREFIXES.iter().any(|prefix| word.starts_with(prefix)) || is_opaque(word))
}

/// Failure text with terminal codes gone and credential-looking lines dropped.
pub fn clean(text: &str) -> String {
    let plain = strip_ansi(text);
    let mut kept: Vec<&str> = Vec::new();
    for line in plain.lines() {
        if !looks_secret(line) {
            kept.push(line);
        } else if kept.last() != Some(&HIDDEN_LINE) {
            kept.push(HIDDEN_LINE);
        }
    }
    kept.join("\n").trim().to_owned()
}

/// True for how the engines say they have no usable login.
pub fn is_sign_in_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "not logged in",
        "not signed in",
        "please run /login",
        "login required",
        "authentication required",
        "authentication_error",
        "auth required",
        "authrequired",
        "invalid api key",
        "unauthorized",
        "status 401",
        "401 unauthorized",
        "token has expired",
        "token expired",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
}

/// The message for a failed run: clean, and pointing at the vendor's own sign-in when
/// that is the cause. Orbyn never runs that command for anyone.
pub fn failure_message(text: &str, sign_in: Option<&str>) -> String {
    let cleaned = clean(text);
    if !is_sign_in_failure(&cleaned) {
        return cleaned;
    }
    match sign_in {
        Some(command) => format!("This engine is not signed in. Run `{command}`, then try again."),
        None => {
            "This engine is not signed in. Sign in through its own CLI, then try again.".to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_codes_are_removed() {
        assert_eq!(
            clean("\u{1b}[31merror\u{1b}[0m: \u{1b}]0;title\u{7}boom"),
            "error: boom"
        );
        assert_eq!(clean("cut off \u{1b}"), "cut off");
    }

    #[test]
    fn credential_lines_go_whole_and_the_rest_stay() {
        let dump = [
            "request failed",
            "Authorization: Bearer abc",
            "x-api-key: sk-ant-12345",
            "url=https://x.test/?token=abc123",
            "password: hunter2",
            "the end",
        ]
        .join("\n");
        let shown = clean(&dump);
        for secret in ["abc", "sk-ant", "hunter2"] {
            assert!(!shown.contains(secret), "{shown}");
        }
        assert_eq!(
            shown,
            format!("request failed\n{HIDDEN_LINE}\nthe end"),
            "neighbouring hidden lines fold into one"
        );
    }

    #[test]
    fn bare_tokens_are_caught_by_their_shape() {
        for line in [
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
            "key eyJhbGciOiJIUzI1NiJ9.e30.sig",
            "value=\"AbCd0123EfGh4567IjKl8901MnOp2345QrSt\"",
        ] {
            assert_eq!(clean(line), HIDDEN_LINE, "{line}");
        }
    }

    #[test]
    fn ordinary_failures_are_left_readable() {
        for line in [
            "Maximum tokens exceeded for this model",
            "cannot open /usr/local/lib/node_modules/@openai/codex/bin/codex.js",
            "No conversation found with session ID: 550e8400-e29b-41d4-a716-446655440000",
            "invalid api key",
            "The engine exited with code 1",
        ] {
            assert_eq!(clean(line), line);
        }
    }

    #[test]
    fn a_login_failure_names_the_vendors_command_and_nothing_else_does() {
        assert_eq!(
            failure_message(
                "Not logged in · Please run /login",
                Some("claude auth login")
            ),
            "This engine is not signed in. Run `claude auth login`, then try again."
        );
        assert!(failure_message("401 Unauthorized", None).contains("its own CLI"));
        assert_eq!(failure_message("disk full", Some("x login")), "disk full");
    }

    #[test]
    fn a_secret_in_a_login_failure_does_not_survive() {
        let shown = failure_message("Unauthorized\ntoken=abc", Some("codex login"));
        assert!(!shown.contains("abc"), "{shown}");
    }
}
