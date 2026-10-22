//! Guarantee `web/build/` exists so `rust-embed` can read it at compile time.
//!
//! The folder is gitignored (it is a build artifact), so a fresh clone has
//! none, and `#[derive(RustEmbed)]` fails the whole workspace build without it.
//! We write a placeholder shell instead. A real `npm --prefix web run build`
//! overwrites it, and the server reports the placeholder on `GET /` so the
//! situation is loud rather than a mysterious blank page.
//!
//! Deliberately no `npm` invocation here: `cargo check --workspace
//! --all-targets` is a workspace gate and must not require Node.

use std::fs;
use std::path::Path;

/// Written only when the folder is missing or has no shell.
const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Alnair web — not built</title>
    <style>
      body { font: 15px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 40rem; padding: 0 1.5rem; }
      code { background: #f4f4f4; padding: 0.1rem 0.35rem; border-radius: 4px; }
      @media (prefers-color-scheme: dark) {
        body { background: #000; color: #e5e5e5; }
        code { background: #141414; }
      }
    </style>
  </head>
  <body>
    <h1>The web UI was not built</h1>
    <p>
      This binary was compiled without a production build of the browser client.
      Run <code>npm --prefix web run build</code> and rebuild Alnair, or start
      <code>alnair web</code> against a tree that has one.
    </p>
  </body>
</html>
"#;

/// Marker the server looks for to report "not built" without parsing HTML.
const PLACEHOLDER_MARKER: &str = "_app/.placeholder";

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let web_build = root.join("../../../web/build");

    if !web_build.join("index.html").is_file() {
        let wrote_dir = fs::create_dir_all(&web_build).is_ok();
        if wrote_dir {
            let _ = fs::write(web_build.join("index.html"), PLACEHOLDER_HTML);
            let marker = web_build.join(PLACEHOLDER_MARKER);
            if let Some(parent) = marker.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&marker, b"placeholder");
            println!(
                "cargo:warning=web/build was missing; wrote a placeholder shell. \
                 Run `npm --prefix web run build` for the real UI."
            );
        }
    }

    println!("cargo:rerun-if-changed=../../../web/build/index.html");
}
