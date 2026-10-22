//! The `/ws` gate: a same-origin cookie plus an `Origin` check.
//!
//! Two independent checks, both required:
//!
//! - **Cookie.** `GET /` and `GET /api/session` set an `HttpOnly`,
//!   `SameSite=Strict` cookie holding a random per-process token. A WebSocket
//!   upgrade from another site does not carry it, because `SameSite=Strict`
//!   refuses to send it cross-site.
//! - **`Origin`.** A WS upgrade is *not* subject to CORS preflight, so a page
//!   on another origin could otherwise open a socket to `127.0.0.1` and drive
//!   the agent. Comparing `Origin` against the bound address closes that,
//!   including DNS-rebinding attempts (which present an attacker-controlled
//!   host name, not the loopback address).
//!
//! The token is never logged and never placed in a URL: query strings end up in
//! shell history, logs and `Referer` headers.

use axum::http::{HeaderMap, header};
use std::net::SocketAddr;

/// Name of the auth cookie.
pub const COOKIE_NAME: &str = "alnair_web";

/// Port the Vite dev server listens on; only accepted in debug builds.
const DEV_ORIGIN_PORT: u16 = 5173;

/// Why a request was refused. Rendered as a one-line body and logged (without
/// the cookie value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// No `Cookie` header carrying [`COOKIE_NAME`].
    MissingCookie,
    /// Cookie present but not the current process token.
    BadCookie,
    /// No `Origin` header at all.
    MissingOrigin,
    /// `Origin` present but not one we serve.
    ForeignOrigin,
}

impl RejectReason {
    /// The wire string, also used as the 403 body.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingCookie => "missing auth cookie; reload the page",
            Self::BadCookie => "stale auth cookie; reload the page",
            Self::MissingOrigin => "missing Origin header",
            Self::ForeignOrigin => "origin not allowed",
        }
    }
}

/// Everything the gate needs about the running server.
#[derive(Debug, Clone)]
pub struct Gate {
    token: String,
    /// Address actually bound (so `--bind 127.0.0.1:0` compares the real port).
    pub bound: SocketAddr,
}

impl Gate {
    /// Build a gate with a fresh random token.
    pub fn new(bound: SocketAddr) -> Self {
        Self {
            token: random_token(),
            bound,
        }
    }

    /// The `Set-Cookie` value. `HttpOnly` keeps it away from page scripts;
    /// `SameSite=Strict` is what makes a cross-site upgrade cookie-less.
    pub fn set_cookie(&self) -> String {
        format!(
            "{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
            self.token
        )
    }

    /// Whether `origin` is one this server serves.
    ///
    /// Accepts the bound address verbatim, `localhost` on the bound port (the
    /// browser may normalise `127.0.0.1` to `localhost` or vice versa), and in
    /// debug builds the Vite dev origin so HMR works through the proxy.
    pub fn origin_allowed(&self, origin: &str) -> bool {
        let port = self.bound.port();
        let allowed = [
            format!("http://{}", self.bound),
            format!("http://localhost:{port}"),
            format!("http://127.0.0.1:{port}"),
            format!("http://[::1]:{port}"),
        ];
        if allowed.iter().any(|candidate| candidate == origin) {
            return true;
        }
        // The dev server proxies `/ws`, so the page's origin is the Vite one.
        // Gated on debug: a release binary must never accept it.
        cfg!(debug_assertions)
            && (origin == format!("http://localhost:{DEV_ORIGIN_PORT}")
                || origin == format!("http://127.0.0.1:{DEV_ORIGIN_PORT}"))
    }

    /// Run both checks. `Err` carries the reason for the 403 and the log line.
    pub fn check(&self, headers: &HeaderMap) -> Result<(), RejectReason> {
        self.check_cookie(headers)?;
        self.check_origin(headers)
    }

    fn check_cookie(&self, headers: &HeaderMap) -> Result<(), RejectReason> {
        let Some(raw) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) else {
            return Err(RejectReason::MissingCookie);
        };
        let found = raw
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find(|(name, _)| *name == COOKIE_NAME)
            .map(|(_, value)| value);
        match found {
            None => Err(RejectReason::MissingCookie),
            Some(value) if constant_time_eq(value.as_bytes(), self.token.as_bytes()) => Ok(()),
            Some(_) => Err(RejectReason::BadCookie),
        }
    }

    fn check_origin(&self, headers: &HeaderMap) -> Result<(), RejectReason> {
        let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
            return Err(RejectReason::MissingOrigin);
        };
        if self.origin_allowed(origin) {
            Ok(())
        } else {
            Err(RejectReason::ForeignOrigin)
        }
    }
}

/// 32 random bytes, hex encoded.
fn random_token() -> String {
    use rand::{TryRngCore as _, rngs::OsRng};
    let mut bytes = [0u8; 32];
    // `OsRng` is the OS entropy source, not a seeded PRNG: the token gates a
    // process that can run shell commands.
    OsRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG must be available for the web token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Compare without an early exit, so a wrong cookie cannot be discovered one
/// byte at a time by timing the response.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn gate() -> Gate {
        Gate::new("127.0.0.1:2420".parse().unwrap())
    }

    fn headers(cookie: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        if let Some(value) = cookie {
            map.insert(header::COOKIE, HeaderValue::from_str(value).unwrap());
        }
        if let Some(value) = origin {
            map.insert(header::ORIGIN, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn cookie_for(gate: &Gate) -> String {
        format!("{COOKIE_NAME}={}", gate.token)
    }

    #[test]
    fn accepts_its_own_cookie_and_origin() {
        let gate = gate();
        let cookie = cookie_for(&gate);
        assert_eq!(
            gate.check(&headers(Some(&cookie), Some("http://127.0.0.1:2420"))),
            Ok(())
        );
    }

    #[test]
    fn accepts_localhost_on_the_bound_port() {
        let gate = gate();
        let cookie = cookie_for(&gate);
        assert_eq!(
            gate.check(&headers(Some(&cookie), Some("http://localhost:2420"))),
            Ok(())
        );
    }

    #[test]
    fn rejects_a_missing_cookie() {
        let gate = gate();
        assert_eq!(
            gate.check(&headers(None, Some("http://127.0.0.1:2420"))),
            Err(RejectReason::MissingCookie)
        );
    }

    #[test]
    fn rejects_a_stale_cookie() {
        let gate = gate();
        assert_eq!(
            gate.check(&headers(
                Some("alnair_web=deadbeef"),
                Some("http://127.0.0.1:2420")
            )),
            Err(RejectReason::BadCookie)
        );
    }

    #[test]
    fn rejects_a_foreign_origin_even_with_a_valid_cookie() {
        // The whole point of the second check: the cookie alone is not enough,
        // because a same-site attacker page could in principle carry it.
        let gate = gate();
        let cookie = cookie_for(&gate);
        assert_eq!(
            gate.check(&headers(Some(&cookie), Some("http://evil.example"))),
            Err(RejectReason::ForeignOrigin)
        );
    }

    #[test]
    fn rejects_a_missing_origin() {
        let gate = gate();
        let cookie = cookie_for(&gate);
        assert_eq!(
            gate.check(&headers(Some(&cookie), None)),
            Err(RejectReason::MissingOrigin)
        );
    }

    #[test]
    fn rejects_dns_rebinding_hosts() {
        let gate = gate();
        let cookie = cookie_for(&gate);
        // A rebinding attack presents the attacker's hostname, not loopback.
        assert_eq!(
            gate.check(&headers(Some(&cookie), Some("http://rebind.evil:2420"))),
            Err(RejectReason::ForeignOrigin)
        );
    }

    #[test]
    fn tokens_differ_between_gates() {
        assert_ne!(gate().token, gate().token);
    }

    #[test]
    fn cookie_is_httponly_and_strict() {
        let cookie = gate().set_cookie();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.starts_with("alnair_web="));
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
