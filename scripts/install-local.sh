#!/bin/sh
#
# Alnair local installer (macOS / Linux) - installs a LOCALLY BUILT artifact.
#
# The offline counterpart to install.sh: it never touches the network. It takes
# the archive produced by `cargo build --profile release-dist` (see
# docs/RELEASE.md), verifies it against the SHA256SUMS manifest beside it, and
# installs into the SAME managed layout the self-updater maintains:
#
#   <home>/downloads/alnair-<version>-<os>-<arch>   versioned binary
#   <home>/bin/alnair -> ../downloads/...           atomic symlink
#
# Because the layout matches, `alnair update` takes over from a local install
# without knowing it was installed by hand.
#
# Usage:
#   sh scripts/install-local.sh
#   sh scripts/install-local.sh dist/alnair-0.1.2-aarch64-apple-darwin.tar.gz
#   sh scripts/install-local.sh --home /tmp/alnair-test --no-path
#
# Environment:
#   ALNAIR_SHARE_DIR   install root (default: ~/.alnair)

set -eu

err() {
    printf 'install-local.sh: error: %s\n' "$*" >&2
    exit 1
}

warn() {
    printf 'install-local.sh: warning: %s\n' "$*" >&2
}

usage() {
    sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
}

# -- Platform detection -------------------------------------------------------
# Same (os, arch) vocabulary the self-updater's detect_platform() uses, which is
# what the versioned binary name is built from.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
    Darwin)
        PLATFORM_OS="macos"
        case "$ARCH" in
            arm64|aarch64) PLATFORM_ARCH="aarch64"; TRIPLE="aarch64-apple-darwin" ;;
            x86_64)        PLATFORM_ARCH="x86_64";  TRIPLE="x86_64-apple-darwin" ;;
            *) err "unsupported macOS architecture: $ARCH" ;;
        esac
        ;;
    Linux)
        PLATFORM_OS="linux"
        case "$ARCH" in
            arm64|aarch64) PLATFORM_ARCH="aarch64"; TRIPLE="aarch64-unknown-linux-gnu" ;;
            x86_64|amd64)  PLATFORM_ARCH="x86_64";  TRIPLE="x86_64-unknown-linux-gnu" ;;
            *) err "unsupported Linux architecture: $ARCH" ;;
        esac
        ;;
    *)
        err "unsupported OS: $OS (Windows: use scripts/install-local.ps1)"
        ;;
esac

# -- Arguments ----------------------------------------------------------------
ARCHIVE=""
ALNAIR_HOME="${ALNAIR_SHARE_DIR:-$HOME/.alnair}"
SKIP_CHECKSUM=0
NO_PATH=0

while [ $# -gt 0 ]; do
    case "$1" in
        --home)
            [ $# -ge 2 ] || err "--home requires an argument"
            ALNAIR_HOME="$2"
            shift
            ;;
        --home=*)
            ALNAIR_HOME="${1#--home=}"
            ;;
        --skip-checksum)
            SKIP_CHECKSUM=1
            ;;
        --no-path)
            NO_PATH=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            err "unknown option: $1"
            ;;
        *)
            [ -z "$ARCHIVE" ] || err "unexpected extra argument: $1"
            ARCHIVE="$1"
            ;;
    esac
    shift
done

# -- Resolve the archive ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -z "$ARCHIVE" ]; then
    DIST_DIR="$REPO_ROOT/dist"
    [ -d "$DIST_DIR" ] || err "no archive given and $DIST_DIR does not exist. Build first: cargo build --profile release-dist -p alnair-bin"
    # Newest matching archive; `ls -t` is the portable stand-in for sorting.
    ARCHIVE="$(ls -t "$DIST_DIR"/alnair-*-"$TRIPLE".tar.gz 2>/dev/null | head -n 1 || true)"
    [ -n "$ARCHIVE" ] || err "no alnair-*-$TRIPLE.tar.gz in $DIST_DIR. Build first: cargo build --profile release-dist -p alnair-bin"
fi

[ -f "$ARCHIVE" ] || err "archive not found: $ARCHIVE"
# Absolute path, because the rest of the script may cd.
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
ARCHIVE_NAME="$(basename "$ARCHIVE")"

# -- Version from the archive name -------------------------------------------
# alnair-<version>-<triple>.tar.gz. Strip the fixed prefix and the known
# suffix, so a pre-release version stays whole.
VERSION="${ARCHIVE_NAME#alnair-}"
VERSION="${VERSION%-"$TRIPLE".tar.gz}"
[ "$VERSION" != "$ARCHIVE_NAME" ] || err "unexpected archive name '$ARCHIVE_NAME' (expected alnair-<version>-$TRIPLE.tar.gz)"
[ -n "$VERSION" ] || err "could not read a version from '$ARCHIVE_NAME'"

ALNAIR_HOME="${ALNAIR_HOME%/}"
BIN_DIR="$ALNAIR_HOME/bin"
DOWNLOADS_DIR="$ALNAIR_HOME/downloads"
VERSIONED="$DOWNLOADS_DIR/alnair-${VERSION}-${PLATFORM_OS}-${PLATFORM_ARCH}"

printf 'Archive: %s\nVersion: %s\nInstall: %s\n' "$ARCHIVE" "$VERSION" "$ALNAIR_HOME"

# -- Checksum -----------------------------------------------------------------
if [ "$SKIP_CHECKSUM" -eq 1 ]; then
    warn 'checksum verification SKIPPED (--skip-checksum)'
else
    SUMS_PATH="$(dirname "$ARCHIVE")/SHA256SUMS"
    [ -f "$SUMS_PATH" ] || err "no SHA256SUMS next to $ARCHIVE_NAME. Regenerate it, or pass --skip-checksum if you trust the build."

    if command -v sha256sum >/dev/null 2>&1; then
        sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
    elif command -v shasum >/dev/null 2>&1; then
        sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
    else
        err "either sha256sum or shasum is required to verify the archive (or pass --skip-checksum)"
    fi

    EXPECTED=""
    while IFS=' 	' read -r hash name; do
        name="${name#\*}"
        if [ "$name" = "$ARCHIVE_NAME" ]; then
            EXPECTED="$hash"
        fi
    done < "$SUMS_PATH"
    [ -n "$EXPECTED" ] || err "SHA256SUMS has no entry for $ARCHIVE_NAME"

    ACTUAL="$(sha256_of "$ARCHIVE")"
    [ "$ACTUAL" = "$EXPECTED" ] || err "SHA256 mismatch for $ARCHIVE_NAME: expected $EXPECTED, got $ACTUAL"
    printf 'Checksum verified.\n'
fi

# -- Extract + smoke-test -----------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alnair-local.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

tar -xzf "$ARCHIVE" -C "$TMP_DIR" || err "failed to extract $ARCHIVE_NAME"
# Search the whole extraction rather than only the root, matching the
# PowerShell script (and install.ps1's -Recurse): the release archives put the
# binary at the root, but a hand-made local archive may nest it.
BINARY="$(find "$TMP_DIR" -type f -name alnair -print 2>/dev/null | head -n 1)"
[ -n "$BINARY" ] || err "archive $ARCHIVE_NAME does not contain an 'alnair' binary"
chmod 0755 "$BINARY"

# Smoke-test BEFORE touching the install, so a broken build never replaces a
# working binary.
REPORTED="$("$BINARY" --version 2>&1)" || err "the archive's binary failed to run: $REPORTED"
printf 'Binary reports: %s\n' "$REPORTED"
case "$REPORTED" in
    *"$VERSION"*) ;;
    *) warn "archive is named $VERSION but the binary reports a different version" ;;
esac

# -- Install ------------------------------------------------------------------
mkdir -p "$DOWNLOADS_DIR" "$BIN_DIR"

# Copy into a temp sibling, then rename over the versioned name: a rebuild of
# the same version is a normal local-install event, and an in-place overwrite
# of a binary a running process has mmap'd is what SIGKILLs on macOS.
cp "$BINARY" "$VERSIONED.tmp.$$"
chmod 0755 "$VERSIONED.tmp.$$"
mv -f "$VERSIONED.tmp.$$" "$VERSIONED"

# Atomic symlink swap: create beside, then rename over. Never delete the old
# target - that is the macOS code-signing SIGKILL path documented in the
# self-updater (atomic_symlink_swap).
TMP_LINK="$BIN_DIR/alnair.local.$$"
rm -f "$TMP_LINK"
ln -s "../downloads/$(basename "$VERSIONED")" "$TMP_LINK"
mv -f "$TMP_LINK" "$BIN_DIR/alnair"

"$BIN_DIR/alnair" --version >/dev/null 2>&1 || err "installed binary failed to run through $BIN_DIR/alnair"

printf '\nalnair %s installed to %s\n' "$VERSION" "$BIN_DIR/alnair"
printf 'Versioned copy: %s\n' "$VERSIONED"

# -- PATH ---------------------------------------------------------------------
if [ "$NO_PATH" -eq 1 ]; then
    printf "Run '%s' to get started.\n" "$BIN_DIR/alnair"
    exit 0
fi

case ":$PATH:" in
    *":$BIN_DIR:"*)
        printf 'Run `alnair` to get started.\n'
        ;;
    *)
        # Resolve the login shell's rc file, matching install.sh's choices.
        case "${SHELL:-}" in
            */zsh)
                RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"
                PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
                ;;
            */bash)
                if [ "$PLATFORM_OS" = "macos" ]; then
                    RC_FILE="$HOME/.bash_profile"
                else
                    RC_FILE="$HOME/.bashrc"
                fi
                PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
                ;;
            */fish)
                FISH_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
                mkdir -p "$FISH_CONF_DIR"
                RC_FILE="$FISH_CONF_DIR/config.fish"
                PATH_LINE="fish_add_path $BIN_DIR"
                ;;
            *)
                RC_FILE="$HOME/.profile"
                PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
                ;;
        esac

        if [ -f "$RC_FILE" ] && grep -qF "$BIN_DIR" "$RC_FILE"; then
            printf '%s is already configured in %s.\n' "$BIN_DIR (PATH)" "$RC_FILE"
        else
            printf '\n# Added by the alnair local installer\n%s\n' "$PATH_LINE" >> "$RC_FILE" \
                || err "could not write $RC_FILE - configure it manually: $PATH_LINE"
            printf 'Added %s in %s.\n' "$BIN_DIR (PATH)" "$RC_FILE"
        fi
        printf 'Open a new terminal, then run `alnair` to get started.\n'
        ;;
esac
