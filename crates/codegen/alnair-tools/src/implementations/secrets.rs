//! Credential detection shared by the two paths that move text into a model's
//! context: durable memory writes ([`crate::implementations::memory`]) and
//! codebase snippets.
//!
//! The rules live here rather than in either caller because they answer one
//! question — "does this text contain something that looks like a live
//! credential?" — and a second copy would drift. The callers differ only in
//! what they do about the answer:
//!
//! | Caller | On a hit |
//! |---|---|
//! | `memory_store` | **refuse** the write |
//! | snippet rendering | **replace** the line |
//!
//! ## Why the rules are narrow
//!
//! A false positive costs one retry (memory) or one line of context (snippets);
//! a false negative puts a live credential into a transcript or a file that is
//! injected into every future session. Each pattern is therefore anchored on a
//! recognizable prefix or an assignment shape, so prose *about* credentials —
//! which is exactly what memory should hold — passes untouched.

use std::sync::LazyLock;

/// A credential pattern.
struct SecretRule {
    /// Human name used in messages. Must not contain the value.
    name: &'static str,
    pattern: regex::Regex,
}

/// Patterns that mark text as containing a credential.
static SECRET_RULES: LazyLock<Vec<SecretRule>> = LazyLock::new(|| {
    let rule = |name: &'static str, re: &str| SecretRule {
        name,
        pattern: regex::Regex::new(re).expect("secret-detection pattern must compile"),
    };
    vec![
        rule(
            "a private key block",
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
        ),
        rule("an AWS access key id", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
        rule(
            "a GitHub token",
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
        ),
        rule("an API key", r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}"),
        // A credential assignment, matched as a *component* of a possibly
        // longer identifier. `\bpassword\b` alone missed `DB_PASSWORD=…`
        // because `_` is a word character, and the `.env` rule below is
        // anchored at line start so a comment prefix (`// DB_PASSWORD=…`)
        // defeated that one too — a live secret in a comment would have been
        // rendered verbatim by the snippet reader.
        //
        // The leading `(?:^|[^A-Za-z0-9])` keeps `max_tokens = 4096` out:
        // `tokens` is not the alternation's `token`, and the value must be 12+
        // characters anyway, so a numeric constant never trips it.
        rule(
            "a credential assignment",
            r"(?i)(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+_)*(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*\S{12,}",
        ),
        rule("a bearer token", r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{20,}"),
        // A URL carrying userinfo (`scheme://user:pass@host`) is a credential
        // whatever variable holds it.
        rule(
            "a URL with embedded credentials",
            r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@",
        ),
        // An `.env`-shaped line only counts when the KEY names a credential.
        // Matching every `UPPER=value` line refused ordinary notes that document
        // a constant (`MAX_STORE_CHARS=4000`) — exactly the knowledge the memory
        // tool exists to keep. Values that *look* secret are caught by the rules
        // above; this one catches the opaque-value case (`DB_PASSWORD=hunter2…`).
        //
        // Anchored at line start, so it does NOT fire for a comment carrying the
        // same shape (`// DB_PASSWORD=…`) — the assignment rule above covers
        // that, and covers it better because it also catches lowercase keys.
        rule(
            "a .env-style credential line",
            r"(?m)^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*=.{12,}$",
        ),
    ]
});

/// Marker written in place of a redacted line.
///
/// Deliberately says *why* the line is gone: a caller that silently sees a gap
/// cannot tell redaction from truncation, and may conclude the code does not
/// contain what it does.
pub const REDACTION_MARKER: &str = "[redacted: looks like a credential]";

/// Whether `content` contains something that looks like a credential.
///
/// Returns the rule's name, never the match.
pub fn detect_secret(content: &str) -> Option<&'static str> {
    SECRET_RULES
        .iter()
        .find(|rule| rule.pattern.is_match(content))
        .map(|rule| rule.name)
}

/// Replace every credential-shaped line in `content` with [`REDACTION_MARKER`].
///
/// Returns the redacted text and how many lines were replaced. Line granularity
/// is deliberate: a partially-redacted line would still leak the shape and
/// position of the value, and would leave syntactically broken code in a
/// snippet.
///
/// The trailing newline structure is preserved so line numbers in the snippet
/// still line up with the file.
pub fn redact_lines(content: &str) -> (String, usize) {
    let mut redacted = 0usize;
    let mut out = String::with_capacity(content.len());
    for (index, line) in content.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        if detect_secret(line).is_some() {
            out.push_str(REDACTION_MARKER);
            redacted += 1;
        } else {
            out.push_str(line);
        }
    }
    (out, redacted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_credential_shapes_are_detected() {
        for (text, family) in [
            ("-----BEGIN RSA PRIVATE KEY-----", "private key"),
            ("AKIAIOSFODNN7EXAMPLE", "AWS"),
            ("ghp_1234567890abcdefghijABCDEFGHIJ012345", "GitHub"),
            ("sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "API key"),
            ("password=correcthorsebatterystaple", "assignment"),
            ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "bearer"),
            ("postgres://user:pw@host/db", "URL"),
            ("DB_PASSWORD=hunter2hunter2hunter2", ".env"),
        ] {
            let rule = detect_secret(text)
                .unwrap_or_else(|| panic!("{text:?} should be detected as {family}"));
            assert!(!rule.is_empty(), "rule name must not be empty");
        }
    }

    #[test]
    fn prose_about_credentials_is_not_a_credential() {
        for text in [
            "The API key is stored in 1Password under `alnair-prod`.",
            "// never log the bearer token",
            "MAX_STORE_CHARS=4000 caps a single note.",
            "fn refresh_token(&self) -> Result<()>",
        ] {
            assert_eq!(detect_secret(text), None, "{text:?} must pass");
        }
    }

    /// A `\b`-anchored rule missed `DB_PASSWORD=…` because `_` is a word
    /// character, so a prefixed key never matched. That is the common spelling
    /// in a `.env` file and in shell exports.
    #[test]
    fn a_prefixed_credential_key_is_detected() {
        for text in [
            "DB_PASSWORD=hunter2hunter2hunter2",
            "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrst",
            "MY_APP_SECRET: abcdefghijklmnop",
        ] {
            assert!(detect_secret(text).is_some(), "{text:?} must be detected");
        }
    }

    /// The `.env` rule is anchored at line start, so a comment prefix defeated
    /// it. A snippet of source code is exactly where that shape appears.
    #[test]
    fn a_credential_inside_a_source_comment_is_detected() {
        for text in [
            "// DB_PASSWORD=hunter2hunter2hunter2",
            "# API_KEY=abcdefghijklmnopqrst",
            "    let token: password = \"hunter2hunter2\";",
        ] {
            assert!(detect_secret(text).is_some(), "{text:?} must be detected");
        }
    }

    /// The widened rule must not start refusing ordinary code. These are the
    /// shapes that appear on nearly every line of a Rust file.
    #[test]
    fn ordinary_code_is_not_flagged() {
        for text in [
            "let max_tokens = 4096;",
            "pub fn tokenize(input: &str) -> Vec<Token>",
            "// the token budget lives in alnair-token-estimation",
            "MAX_TOKENS: usize = 8192,",
            "const SECRET_NAME: &str = \"alnair-prod\";",
            "if password.is_empty() { return; }",
        ] {
            assert_eq!(detect_secret(text), None, "{text:?} must pass");
        }
    }

    #[test]
    fn redaction_replaces_whole_lines_and_counts_them() {
        let content = "fn main() {\n    let token = \"password=hunter2hunter2\";\n}";
        let (redacted, count) = redact_lines(content);
        assert_eq!(count, 1);
        assert!(!redacted.contains("hunter2"));
        assert!(redacted.contains(REDACTION_MARKER));
        // Structure preserved: the braces still line up.
        assert!(redacted.starts_with("fn main() {\n"));
        assert!(redacted.ends_with("\n}"));
    }

    #[test]
    fn redaction_preserves_the_line_count() {
        let content = "a\nb\nc\nd";
        let (redacted, count) = redact_lines(content);
        assert_eq!(count, 0);
        assert_eq!(redacted, content);
        assert_eq!(redacted.split('\n').count(), content.split('\n').count());
    }

    #[test]
    fn clean_content_is_returned_unchanged() {
        let content = "pub fn add(a: i32, b: i32) -> i32 { a + b }";
        let (redacted, count) = redact_lines(content);
        assert_eq!(count, 0);
        assert_eq!(redacted, content);
    }
}
