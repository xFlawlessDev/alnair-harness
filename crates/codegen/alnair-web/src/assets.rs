//! The embedded single-page app and the rules that serve it.
//!
//! `web/build/` is produced by `npm --prefix web run build` (adapter-static)
//! and compiled into the binary by `rust-embed`, so Alnair stays a single file.
//! Debug builds read from disk, which is what makes asset iteration work
//! without a Rust rebuild.
//!
//! Serving rules, in order:
//!
//! 1. A path that exists in the build is served as-is.
//! 2. A missing path **with** a file extension is a 404. Returning the shell
//!    for a missing `.js` turns a broken script tag into a syntax error in an
//!    HTML document, which is far harder to diagnose.
//! 3. A missing path **without** an extension gets `index.html`, so a deep link
//!    resolves to the SPA shell.

use axum::http::{StatusCode, header};

/// The SvelteKit build. Paths are relative to the crate root, which is
/// `crates/codegen/alnair-web`, so the app lives three levels up.
///
/// The `disallowed_methods` allow covers the derive's own expansion: rust-embed
/// emits a `Path::canonicalize` call to resolve `#[folder]` at compile time.
/// That path never reaches runtime path handling, so the Windows
/// verbatim-prefix hazard the ban exists for cannot occur here. The allow sits
/// on a module rather than the struct because the generated call lands in an
/// item the derive creates, which an item-level allow does not reach.
#[allow(clippy::disallowed_methods)]
mod build {
    use rust_embed::RustEmbed;

    #[derive(RustEmbed)]
    #[folder = "../../../web/build"]
    pub(super) struct WebBuild;
}

use build::WebBuild;

/// `index.html`, which the SPA fallback and the root route both serve.
const SHELL: &str = "index.html";

/// Written by `build.rs` when no real build was available.
const PLACEHOLDER_MARKER: &str = "_app/.placeholder";

/// A resolved response for one request path.
#[derive(Debug)]
pub struct Asset {
    /// The bytes to send.
    pub body: Vec<u8>,
    /// The `Content-Type` value.
    pub content_type: &'static str,
    /// Whether the bytes are the SPA shell (and so must not be cached).
    pub is_shell: bool,
}

/// True when this binary carries the placeholder rather than a real build.
///
/// Reported at startup and on `GET /api/session` so the operator learns why the
/// page looks empty instead of guessing.
pub fn is_placeholder() -> bool {
    WebBuild::get(PLACEHOLDER_MARKER).is_some()
}

/// Resolve a request path to an asset, applying the three serving rules.
///
/// `path` is the URL path as received (leading `/`, no query).
pub fn resolve(path: &str) -> Option<Asset> {
    let trimmed = path.trim_start_matches('/');

    // Rule 1: an exact hit. The root is the shell.
    let candidate = if trimmed.is_empty() { SHELL } else { trimmed };
    if let Some(asset) = WebBuild::get(candidate) {
        return Some(Asset {
            content_type: content_type_of(candidate),
            is_shell: candidate == SHELL,
            body: asset.data.into_owned(),
        });
    }

    // Rule 2: a missing file is a miss, never the shell.
    if has_extension(candidate) {
        return None;
    }

    // Rule 3: an extensionless deep link gets the shell.
    WebBuild::get(SHELL).map(|asset| Asset {
        body: asset.data.into_owned(),
        content_type: "text/html; charset=utf-8",
        is_shell: true,
    })
}

/// The 404 body for a missing asset.
pub fn not_found() -> (
    StatusCode,
    [(header::HeaderName, &'static str); 1],
    &'static str,
) {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "not found",
    )
}

/// Whether the last segment carries a file extension.
///
/// Deliberately simple: the build's file names are hashed and well-formed, and
/// a dotted directory would only cost us the SPA fallback for that one path.
fn has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.') && !segment.starts_with('.'))
}

/// Map an extension to a `Content-Type`.
///
/// A hand-rolled table rather than `mime_guess`: the build emits eight
/// extensions, and this keeps the dependency surface small.
fn content_type_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or_default();
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_serves_the_shell() {
        let asset = resolve("/").expect("root must resolve");
        assert!(asset.is_shell);
        assert_eq!(asset.content_type, "text/html; charset=utf-8");
    }

    #[test]
    fn extensionless_deep_link_serves_the_shell() {
        let asset = resolve("/sessions/abc").expect("deep link must resolve");
        assert!(asset.is_shell, "a deep link must get the SPA shell");
    }

    #[test]
    fn missing_asset_with_extension_is_a_miss() {
        // Returning the shell here would turn a missing script into an HTML
        // document parsed as JavaScript.
        assert!(resolve("/_app/immutable/chunks/nope.js").is_none());
        assert!(resolve("/favicon.ico").is_none());
    }

    #[test]
    fn known_extensions_map_to_types() {
        assert_eq!(content_type_of("a/b.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_of("a/b.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_of("fonts/x.woff2"), "font/woff2");
        assert_eq!(content_type_of("a/b.unknown"), "application/octet-stream");
    }

    #[test]
    fn extension_detection_ignores_dot_directories() {
        assert!(!has_extension(".well-known/path"));
        assert!(!has_extension("plain"));
        assert!(has_extension("a.js"));
    }
}
