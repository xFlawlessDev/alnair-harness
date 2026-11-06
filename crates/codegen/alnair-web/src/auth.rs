//! One-use pairing links, signed browser sessions, and explicit origin checks.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{TryRngCore as _, rngs::OsRng};
use ring::hmac;
use subtle::ConstantTimeEq as _;
use tokio_util::sync::CancellationToken;
use url::Url;

/// Pairing links expire after five minutes.
pub const PAIR_TTL: Duration = Duration::from_secs(300);
/// Signed sessions survive service restarts for thirty days.
pub const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_PAIRS: usize = 1000;

struct SessionKey {
    key: hmac::Key,
    revoked: CancellationToken,
}

/// Authentication state for one listener. Secrets are never Debug-formatted.
pub struct Gate {
    sessions: RwLock<SessionKey>,
    pairs: Mutex<VecDeque<(String, Instant)>>,
    control: String,
    bound: SocketAddr,
    public_url: Option<Url>,
}

/// A validated session, including cancellation when all devices are revoked.
pub struct Session {
    /// Cancelled when the signing key rotates.
    pub revoked: CancellationToken,
    /// Remaining validity, used to close an upgraded socket on expiry.
    pub remaining: Duration,
}

/// A refusal safe to include in an HTTP response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The browser has not paired.
    MissingCookie,
    /// The session is expired, revoked, or invalid.
    BadCookie,
    /// The action needs a browser Origin header.
    MissingOrigin,
    /// The request does not belong to a configured origin.
    ForeignOrigin,
}

impl RejectReason {
    /// Human-readable reason without credential data.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingCookie => "missing auth cookie; run `alnair web pair` on the server",
            Self::BadCookie => {
                "expired or revoked auth cookie; run `alnair web pair` on the server"
            }
            Self::MissingOrigin => "missing Origin header",
            Self::ForeignOrigin => "origin not allowed",
        }
    }
}

impl Gate {
    /// Use a persisted signing secret and a separate, per-process control secret.
    pub fn new(bound: SocketAddr, public_url: Option<Url>, secret: &str, control: String) -> Self {
        Self {
            sessions: RwLock::new(SessionKey {
                key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
                revoked: CancellationToken::new(),
            }),
            pairs: Mutex::new(VecDeque::new()),
            control,
            bound,
            public_url,
        }
    }

    /// Allocate a bounded, in-memory code with 128 bits of OS entropy.
    pub fn issue_pair(&self) -> anyhow::Result<String> {
        let code = random_token(16)?;
        let now = Instant::now();
        let mut pairs = self
            .pairs
            .lock()
            .map_err(|_| anyhow::anyhow!("pairing lock poisoned"))?;
        pairs.retain(|(_, expires)| *expires > now);
        if pairs.len() >= MAX_PAIRS {
            pairs.pop_front();
        }
        pairs.push_back((code.clone(), now + PAIR_TTL));
        Ok(code)
    }

    /// Atomically remove a code before issuing its session token.
    pub fn consume_pair(&self, code: &str) -> Option<String> {
        let mut pairs = self.pairs.lock().ok()?;
        let index = pairs.iter().position(|(candidate, _)| candidate == code)?;
        let (_, expires) = pairs.remove(index)?;
        if expires <= Instant::now() {
            return None;
        }
        let sessions = self.sessions.read().ok()?;
        let payload = format!(
            "{}.{}",
            unix_seconds() + SESSION_TTL.as_secs(),
            random_token(16).ok()?
        );
        let signature = hmac::sign(&sessions.key, self.session_message(&payload).as_bytes());
        Some(format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }

    fn session_message(&self, payload: &str) -> String {
        format!("alnair-web-session-v1:{}:{payload}", self.bound.port())
    }

    /// Cookie names distinguish listeners because cookies ignore ports.
    pub fn cookie_name(&self) -> String {
        format!("alnair_session_{}", self.bound.port())
    }

    /// HTTPS proxy origins get a Secure cookie; forwarded headers are ignored.
    pub fn set_cookie(&self, token: &str) -> String {
        let secure = if self
            .public_url
            .as_ref()
            .is_some_and(|url| url.scheme() == "https")
        {
            "; Secure"
        } else {
            ""
        };
        format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{secure}",
            self.cookie_name(),
            SESSION_TTL.as_secs()
        )
    }

    /// Accept configured names or literal addresses on this listener.
    pub fn origin_allowed(&self, origin: &str) -> bool {
        if self
            .public_url
            .as_ref()
            .is_some_and(|url| url.origin().ascii_serialization() == origin)
        {
            return true;
        }
        let Ok(url) = Url::parse(origin) else {
            return false;
        };
        if url.scheme() != "http" || url.origin().ascii_serialization() != origin {
            return false;
        }
        if cfg!(debug_assertions)
            && url.port_or_known_default() == Some(5173)
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        {
            return true;
        }
        if url.port_or_known_default() != Some(self.bound.port()) {
            return false;
        }
        match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => {
                ip.is_loopback()
                    || self.bound.ip() == ip
                    || (self.bound.is_ipv4() && self.bound.ip().is_unspecified())
            }
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback()
                    || self.bound.ip() == ip
                    || (self.bound.is_ipv6() && self.bound.ip().is_unspecified())
            }
            _ => false,
        }
    }

    /// Check Host even on navigations, which have no Origin header.
    pub fn check_host(&self, headers: &HeaderMap) -> Result<(), RejectReason> {
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .ok_or(RejectReason::ForeignOrigin)?;
        if self.origin_allowed(&format!("http://{host}"))
            || self.origin_allowed(&format!("https://{host}"))
        {
            Ok(())
        } else {
            Err(RejectReason::ForeignOrigin)
        }
    }

    /// Require a signed cookie and, for mutations and sockets, a same-origin header.
    pub fn check(
        &self,
        headers: &HeaderMap,
        require_origin: bool,
    ) -> Result<Session, RejectReason> {
        self.check_host(headers)?;
        match headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        {
            Some(origin) => {
                let host = headers
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok());
                let authority = origin
                    .strip_prefix("http://")
                    .or_else(|| origin.strip_prefix("https://"));
                if !self.origin_allowed(origin) || authority != host {
                    return Err(RejectReason::ForeignOrigin);
                }
            }
            None if require_origin => return Err(RejectReason::MissingOrigin),
            None => {}
        }
        let name = self.cookie_name();
        let token = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|raw| raw.split(';'))
            .filter_map(|part| part.trim().split_once('='))
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
            .ok_or(RejectReason::MissingCookie)?;
        let (payload, signature) = token.rsplit_once('.').ok_or(RejectReason::BadCookie)?;
        let expires = payload
            .split_once('.')
            .and_then(|(expires, _)| expires.parse::<u64>().ok())
            .ok_or(RejectReason::BadCookie)?;
        let remaining = expires
            .checked_sub(unix_seconds())
            .filter(|value| *value > 0)
            .ok_or(RejectReason::BadCookie)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| RejectReason::BadCookie)?;
        let sessions = self.sessions.read().map_err(|_| RejectReason::BadCookie)?;
        hmac::verify(
            &sessions.key,
            self.session_message(payload).as_bytes(),
            &signature,
        )
        .map_err(|_| RejectReason::BadCookie)?;
        Ok(Session {
            revoked: sessions.revoked.clone(),
            remaining: Duration::from_secs(remaining),
        })
    }

    /// Service administration never accepts a paired browser cookie.
    pub fn check_control(&self, headers: &HeaderMap) -> bool {
        if headers.contains_key(header::ORIGIN) || headers.contains_key("sec-fetch-mode") {
            return false;
        }
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| bool::from(value.as_bytes().ct_eq(self.control.as_bytes())))
    }

    /// Replace the live signing key after its replacement has been persisted.
    pub fn revoke(&self, secret: &str) -> anyhow::Result<()> {
        // Same lock order as consume_pair prevents revoke/consume deadlocks.
        let mut pairs = self
            .pairs
            .lock()
            .map_err(|_| anyhow::anyhow!("pairing lock poisoned"))?;
        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| anyhow::anyhow!("session lock poisoned"))?;
        sessions.revoked.cancel();
        *sessions = SessionKey {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
            revoked: CancellationToken::new(),
        };
        pairs.clear();
        Ok(())
    }
}

/// OS entropy failures propagate instead of issuing predictable credentials.
pub fn random_token(bytes: usize) -> anyhow::Result<String> {
    let mut buffer = vec![0; bytes];
    OsRng
        .try_fill_bytes(&mut buffer)
        .map_err(|error| anyhow::anyhow!("OS entropy unavailable: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Parse an origin without credentials, paths, query strings, or fragments.
pub fn public_url(value: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value)?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "public URL must be an http(s) origin, e.g. https://alnair.example.com"
    );
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Gate {
        Gate::new(
            "0.0.0.0:2420".parse().unwrap(),
            None,
            "signing secret",
            "control secret".into(),
        )
    }

    fn headers(gate: &Gate, token: &str, origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "192.168.1.20:2420".parse().unwrap());
        headers.insert(header::ORIGIN, origin.parse().unwrap());
        headers.insert(
            header::COOKIE,
            format!("{}={token}", gate.cookie_name()).parse().unwrap(),
        );
        headers
    }

    #[test]
    fn pairing_is_single_use_and_sessions_survive_restart() {
        let gate = gate();
        let code = gate.issue_pair().unwrap();
        let token = gate.consume_pair(&code).unwrap();
        assert!(gate.consume_pair(&code).is_none());
        assert!(
            self::gate()
                .check(&headers(&gate, &token, "http://192.168.1.20:2420"), true)
                .is_ok()
        );
    }

    #[test]
    fn rejects_expired_codes() {
        let gate = gate();
        gate.pairs
            .lock()
            .unwrap()
            .push_back(("old".into(), Instant::now() - Duration::from_secs(1)));
        assert!(gate.consume_pair("old").is_none());
    }

    #[test]
    fn rejects_expired_and_forged_sessions() {
        let gate = gate();
        let payload = "1.nonce";
        let signature = hmac::sign(
            &gate.sessions.read().unwrap().key,
            gate.session_message(payload).as_bytes(),
        );
        let expired = format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()));
        assert!(
            gate.check(&headers(&gate, &expired, "http://192.168.1.20:2420"), true)
                .is_err()
        );
        let token = gate.consume_pair(&gate.issue_pair().unwrap()).unwrap();
        let (_, signature) = token.rsplit_once('.').unwrap();
        let forged = format!("9999999999.nonce.{signature}");
        assert!(
            gate.check(&headers(&gate, &forged, "http://192.168.1.20:2420"), true)
                .is_err()
        );
    }

    #[test]
    fn cache_evicts_oldest_code_at_capacity() {
        let gate = gate();
        let oldest = gate.issue_pair().unwrap();
        for _ in 0..MAX_PAIRS {
            gate.issue_pair().unwrap();
        }
        assert_eq!(gate.pairs.lock().unwrap().len(), MAX_PAIRS);
        assert!(gate.consume_pair(&oldest).is_none());
    }

    #[test]
    fn rejects_revoked_sessions_and_cancels_live_connections() {
        let gate = gate();
        let token = gate.consume_pair(&gate.issue_pair().unwrap()).unwrap();
        let headers = headers(&gate, &token, "http://192.168.1.20:2420");
        let session = gate.check(&headers, true).unwrap();
        gate.revoke("replacement").unwrap();
        assert!(session.revoked.is_cancelled());
        assert!(gate.check(&headers, true).is_err());
    }

    #[test]
    fn rejects_rebinding_and_cross_origin_requests() {
        let gate = gate();
        assert!(!gate.origin_allowed("http://attacker.example:2420"));
        assert!(!gate.origin_allowed("http://192.168.1.20:2421"));
        let token = gate.consume_pair(&gate.issue_pair().unwrap()).unwrap();
        assert!(
            gate.check(&headers(&gate, &token, "http://192.168.1.21:2420"), true)
                .is_err()
        );
    }

    #[test]
    fn control_requires_its_own_credential_and_rejects_browser_origins() {
        let gate = gate();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer control secret".parse().unwrap(),
        );
        assert!(gate.check_control(&headers));
        headers.insert(header::ORIGIN, "http://localhost:2420".parse().unwrap());
        assert!(!gate.check_control(&headers));
        headers.remove(header::ORIGIN);
        headers.insert(
            header::AUTHORIZATION,
            "Bearer wrong secret".parse().unwrap(),
        );
        assert!(!gate.check_control(&headers));
    }

    #[test]
    fn https_proxy_origin_is_exact_and_sets_secure_cookie() {
        let gate = Gate::new(
            "127.0.0.1:2420".parse().unwrap(),
            Some(public_url("https://alnair.example.com").unwrap()),
            "secret",
            "control".into(),
        );
        assert!(gate.origin_allowed("https://alnair.example.com"));
        assert!(!gate.origin_allowed("https://alnair.example.com.evil.test"));
        assert!(gate.set_cookie("token").ends_with("; Secure"));
        assert!(public_url("https://user:password@example.com/").is_err());
        assert!(public_url("https://example.com/prefix").is_err());
    }
}
