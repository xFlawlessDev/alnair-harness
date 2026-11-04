//! Write-path policy for `memory_store`: size limits, emptiness, and secret
//! refusal.
//!
//! Everything here is a pure function over the note text so the rules can be
//! table-tested without touching a filesystem or a backend. Credential
//! *detection* lives in [`crate::implementations::secrets`] because the
//! codebase snippet renderer needs the same rules; this module owns only what
//! `memory_store` does about a hit (refuse the write).
//!
//! ## Why refuse rather than redact
//!
//! Memory is read back into future sessions as trusted context. A redacted
//! secret still leaks its shape and location, and a silently-redacted note gives
//! the model a false impression that it stored what it wrote. Refusing with an
//! actionable message lets the model store a *reference* instead
//! (`"the key lives in 1Password item X"`), which is what durable memory should
//! contain anyway.

use crate::implementations::secrets;

/// Maximum characters a single `memory_store` call may append.
///
/// Chosen to stay inside one small `write(2)` so concurrent appenders cannot
/// interleave mid-note, and to keep a single note from dominating the chunk
/// budget in `[memory.index].max_chunk_chars` (default 1600).
pub const MAX_STORE_CHARS: usize = 4000;

/// Why a note was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// Content was empty or whitespace-only after trimming.
    Empty,
    /// Content exceeded [`MAX_STORE_CHARS`].
    TooLong { chars: usize, max: usize },
    /// Content matched a credential pattern.
    ///
    /// Carries only the rule's human name — never the matched text, which would
    /// put the secret in the tool error and therefore in the transcript.
    Secret { rule: &'static str },
}

impl Rejection {
    /// Model-facing message. Names the rule and says what to do instead.
    pub fn message(&self) -> String {
        match self {
            Self::Empty => {
                "refused: content is empty. Store a concrete note (a decision, a convention, \
                 a gotcha), not a placeholder."
                    .to_string()
            }
            Self::TooLong { chars, max } => format!(
                "refused: content is {chars} characters, over the {max}-character limit. \
                 Store one fact per call and split longer notes."
            ),
            Self::Secret { rule } => format!(
                "refused: content looks like {rule}. Durable memory is read back as trusted \
                 context in future sessions, so secrets must not be stored. Record where the \
                 credential lives (for example the secret manager item name) instead of its value."
            ),
        }
    }
}

/// Whether `content` contains something that looks like a credential.
///
/// Delegates to [`secrets::detect_secret`]: the codebase snippet renderer needs
/// the same rules, and a second copy of the pattern list would drift.
pub fn detect_secret(content: &str) -> Option<&'static str> {
    secrets::detect_secret(content)
}

/// Validate a note before it reaches the filesystem or the backend.
///
/// Order matters for the message the model sees: emptiness first (cheapest fix),
/// then size, then credentials. A note that is both too long and secret-shaped
/// reports the size problem, because shortening it is the obvious next step and
/// the secret check re-runs afterwards.
pub fn validate(content: &str) -> Result<(), Rejection> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(Rejection::Empty);
    }
    // Count characters, not bytes: the limit is about what the model wrote, and
    // a CJK or emoji note would otherwise be cut at a third of its length.
    let chars = trimmed.chars().count();
    if chars > MAX_STORE_CHARS {
        return Err(Rejection::TooLong {
            chars,
            max: MAX_STORE_CHARS,
        });
    }
    if let Some(rule) = detect_secret(trimmed) {
        return Err(Rejection::Secret { rule });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Emptiness

    #[test]
    fn empty_and_whitespace_are_rejected() {
        for content in ["", "   ", "\n\n\t ", "\r\n"] {
            assert_eq!(
                validate(content),
                Err(Rejection::Empty),
                "{content:?} must be rejected as empty"
            );
        }
    }

    #[test]
    fn a_single_character_is_accepted() {
        assert_eq!(validate("x"), Ok(()));
    }

    // Size

    #[test]
    fn content_at_the_limit_is_accepted() {
        let at_limit = "a".repeat(MAX_STORE_CHARS);
        assert_eq!(validate(&at_limit), Ok(()));
    }

    #[test]
    fn content_over_the_limit_reports_the_actual_size() {
        let over = "a".repeat(MAX_STORE_CHARS + 1);
        match validate(&over) {
            Err(Rejection::TooLong { chars, max }) => {
                assert_eq!(chars, MAX_STORE_CHARS + 1);
                assert_eq!(max, MAX_STORE_CHARS);
            }
            other => panic!("expected TooLong, got {other:?}"),
        }
    }

    /// The limit counts characters, not bytes: a multi-byte note must not be
    /// rejected at a quarter of the documented length.
    #[test]
    fn the_limit_counts_characters_not_bytes() {
        // 4 bytes per char in UTF-8. 1500 chars = 6000 bytes, i.e. byte length
        // is over the limit while the char count is well under it.
        let wide = "𝒳".repeat(1500);
        assert!(
            wide.len() > MAX_STORE_CHARS,
            "precondition: byte length exceeds the limit"
        );
        assert!(
            wide.chars().count() < MAX_STORE_CHARS,
            "precondition: char count is under the limit"
        );
        assert_eq!(
            validate(&wide),
            Ok(()),
            "the limit is in characters; 1500 chars must pass"
        );
    }

    #[test]
    fn leading_and_trailing_whitespace_does_not_count_toward_the_limit() {
        let padded = format!("   {}   ", "a".repeat(MAX_STORE_CHARS));
        assert_eq!(validate(&padded), Ok(()));
    }

    // Secrets

    #[test]
    fn private_key_blocks_are_rejected() {
        for header in [
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----",
        ] {
            let note = format!("deploy key:\n{header}\nMIIEow...");
            assert!(
                matches!(validate(&note), Err(Rejection::Secret { .. })),
                "{header} must be rejected"
            );
        }
    }

    #[test]
    fn cloud_and_vcs_tokens_are_rejected() {
        for note in [
            "aws AKIAIOSFODNN7EXAMPLE here",
            "aws ASIAIOSFODNN7EXAMPLE here",
            "gh token ghp_1234567890abcdefghijABCDEFGHIJ012345",
            "pat github_pat_11ABCDEFG0abcdefghijklmnop",
        ] {
            assert!(
                matches!(validate(note), Err(Rejection::Secret { .. })),
                "{note:?} must be rejected"
            );
        }
    }

    #[test]
    fn provider_keys_are_rejected() {
        for note in [
            "openai sk-abcdefghijklmnopqrstuvwxyz123456",
            "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
        ] {
            assert!(
                matches!(validate(note), Err(Rejection::Secret { .. })),
                "{note:?} must be rejected"
            );
        }
    }

    #[test]
    fn credential_assignments_are_rejected() {
        for note in [
            "api_key = supersecretvalue123",
            "API-KEY: anotherlongsecret99",
            "password=correcthorsebatterystaple",
            "token: eyJhbGciOiJIUzI1NiJ9.abc",
        ] {
            assert!(
                matches!(validate(note), Err(Rejection::Secret { .. })),
                "{note:?} must be rejected"
            );
        }
    }

    #[test]
    fn bearer_tokens_are_rejected() {
        assert!(matches!(
            validate("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
            Err(Rejection::Secret { .. })
        ));
    }

    #[test]
    fn dotenv_shaped_lines_are_rejected() {
        assert!(matches!(
            validate("DATABASE_URL=postgres://user:pw@host/db"),
            Err(Rejection::Secret { .. })
        ));
        // The opaque-value case the `.env` rule exists for.
        assert!(matches!(
            validate("DB_PASSWORD=hunter2hunter2hunter2"),
            Err(Rejection::Secret { .. })
        ));
    }

    /// Ordinary engineering notes must survive. These are the shapes the tool is
    /// *for*, so a false positive here would make the tool useless.
    #[test]
    fn ordinary_notes_are_accepted() {
        for note in [
            "Decision: config.toml writers resolve through config_write_dest before naming the tmp file.",
            "Convention: every new crate needs a `[lints] workspace = true` block.",
            "Gotcha: `dirs::home_dir()` ignores HOME on Windows; inject the home instead.",
            "The API key is stored in 1Password under `alnair-prod`.",
            "Run `cargo test -p alnair-tools memory` before touching the registry.",
            "Naming: token budget lives in alnair-token-estimation.",
            "MAX_STORE_CHARS=4000 caps a single note.",
        ] {
            assert_eq!(validate(note), Ok(()), "{note:?} must be accepted");
        }
    }

    // Messages

    /// The refusal message must never echo the credential: the tool error lands
    /// in the transcript, which is exactly what the policy is protecting.
    #[test]
    fn rejection_messages_never_contain_the_secret() {
        let secret = "ghp_1234567890abcdefghijABCDEFGHIJ012345";
        let note = format!("token is {secret}");
        let rejection = validate(&note).unwrap_err();
        let message = rejection.message();
        assert!(
            !message.contains(secret),
            "message leaked the secret: {message}"
        );
        assert!(
            !message.contains("ghp_"),
            "message leaked the token prefix: {message}"
        );
        // It must still be actionable.
        assert!(message.contains("refused"), "message must say it refused");
    }

    #[test]
    fn secret_message_names_the_rule() {
        let rejection = validate("AKIAIOSFODNN7EXAMPLE").unwrap_err();
        match rejection {
            Rejection::Secret { rule } => assert!(
                rule.contains("AWS"),
                "rule name should identify the family, got {rule:?}"
            ),
            other => panic!("expected Secret, got {other:?}"),
        }
    }

    #[test]
    fn too_long_message_reports_both_numbers() {
        let message = validate(&"a".repeat(MAX_STORE_CHARS + 5))
            .unwrap_err()
            .message();
        assert!(message.contains(&(MAX_STORE_CHARS + 5).to_string()));
        assert!(message.contains(&MAX_STORE_CHARS.to_string()));
    }

    // Ordering

    /// A note that is both oversized and secret-shaped reports the size first:
    /// shortening is the obvious next step, and the secret check re-runs after.
    #[test]
    fn size_is_reported_before_secrets() {
        let note = format!("AKIAIOSFODNN7EXAMPLE {}", "a".repeat(MAX_STORE_CHARS));
        assert!(matches!(validate(&note), Err(Rejection::TooLong { .. })));
    }
}
