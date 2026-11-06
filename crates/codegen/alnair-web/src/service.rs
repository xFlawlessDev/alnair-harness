//! User-owned service files and detached process lifecycle. No PID-based kills.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::time::Duration;

use alnair_shell::util::{fs::replace_file, secure_file::ensure_owner_only_permissions};
use anyhow::{Context as _, Result};
use fs2::FileExt as _;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tracing::warn;

use crate::auth::{public_url, random_token};

/// Persisted launch settings. Credentials live in separate owner-only files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceConfig {
    /// Listener address; loopback unless explicitly exposed.
    pub bind: SocketAddr,
    /// Exact externally visible origin behind a reverse proxy.
    pub public_url: Option<String>,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 2420)),
            public_url: None,
        }
    }
}

/// The discovery contract. Deliberately has no Debug implementation.
#[derive(Clone, Serialize, Deserialize)]
pub struct Registration {
    /// PID is informational; control requests authenticate the running instance.
    pub pid: u32,
    /// Actual listener address, including an OS-assigned port.
    pub bound: SocketAddr,
    /// Settings used for this launch.
    pub config: ServiceConfig,
    /// Per-process credential; never printed or passed in process arguments.
    pub control_token: String,
}

impl Registration {
    /// Local control address; wildcard listeners are reached over loopback.
    pub fn control_url(&self) -> String {
        format!("http://{}", local_address(self.bound))
    }

    /// Browser origin. A wildcard bind needs a reachable IP supplied when pairing.
    pub fn browser_url(&self) -> String {
        self.config
            .public_url
            .clone()
            .unwrap_or_else(|| self.control_url())
    }
}

/// Files are scoped to Alnair's home. Tests use a TempDir-owned path.
#[derive(Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// User-global location; refusing the cwd fallback keeps secrets out of repos.
    pub fn user() -> Result<Self> {
        let home = alnair_config::user_alnair_home()
            .context("web service needs a user home or ALNAIR_SHARE_DIR")?;
        Ok(Self::new(home.join("web")))
    }

    /// Explicit location, primarily for isolated integration tests.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Service log path, under the same private directory as its registration.
    pub fn log_path(&self) -> PathBuf {
        self.root.join("service.log")
    }

    fn prepare(&self) -> Result<()> {
        refuse_symlink(&self.root)?;
        fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(windows)]
        alnair_shell::util::secure_file::set_windows_secure_permissions(&self.root)?;
        Ok(())
    }

    fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        refuse_symlink(&self.root)?;
        let path = self.root.join(name);
        refuse_symlink(&path)?;
        ensure_owner_only_permissions(&path)?;
        match fs::read(&path) {
            Ok(data) => Ok(Some(
                serde_json::from_slice(&data)
                    .with_context(|| format!("invalid {}", path.display()))?,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        self.prepare()?;
        let destination = self.root.join(name);
        refuse_symlink(&destination)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        // Apply the Windows ACL before writing any secret bytes.
        ensure_owner_only_permissions(temporary.path())?;
        temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
        temporary.as_file().sync_all()?;
        replace_file(temporary.path(), &destination)?;
        Ok(())
    }

    /// Load saved bind and proxy settings, without starting a process.
    pub fn config(&self) -> Result<ServiceConfig> {
        Ok(self.read("config.json")?.unwrap_or_default())
    }

    /// Load the current registration. A missing file is a normal state.
    pub fn registration(&self) -> Result<Option<Registration>> {
        self.read("service.json")
    }

    fn lock_held(&self) -> Result<bool> {
        let path = self.root.join("service.lock");
        refuse_symlink(&self.root)?;
        refuse_symlink(&path)?;
        let file = match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        match file.try_lock_exclusive() {
            Ok(()) => Ok(false),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                Ok(true)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Hold this lease until the server and its sockets have shut down.
    pub fn acquire(&self) -> Result<Lease> {
        self.prepare()?;
        let path = self.root.join("service.lock");
        refuse_symlink(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        ensure_owner_only_permissions(&path)?;
        file.try_lock_exclusive().context(
            "another Alnair web server is running; use `alnair web pair` or `alnair web stop`",
        )?;
        Ok(Lease {
            store: self.clone(),
            _file: file,
            registered: false,
        })
    }

    /// Persist a replacement signing key. Called on a blocking thread.
    pub fn rotate_secret(&self) -> Result<String> {
        let secret = random_token(32)?;
        self.write("auth.json", &secret)?;
        Ok(secret)
    }
}

/// Owns the process-wide service lock and cleans registration before releasing it.
pub struct Lease {
    store: Store,
    _file: File,
    registered: bool,
}

impl Lease {
    /// Load the signing key while the lifetime lock prevents competing writers.
    pub fn secret(&self) -> Result<String> {
        match self.store.read::<String>("auth.json")? {
            Some(secret) => {
                anyhow::ensure!(secret.len() >= 43, "invalid web signing secret");
                Ok(secret)
            }
            None => self.store.rotate_secret(),
        }
    }

    /// Publish only after binding. A failed startup never looks ready to clients.
    pub fn register(&mut self, registration: &Registration) -> Result<()> {
        self.store.write("config.json", &registration.config)?;
        self.store.write("service.json", registration)?;
        self.registered = true;
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.registered
            && let Err(error) = fs::remove_file(self.store.root.join("service.json"))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            warn!(%error, "web: failed to remove service registration");
        }
        // Keep the lock inode: deleting it would let concurrent starters lock different files.
    }
}

fn refuse_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "refusing web store symlink: {}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn local_address(mut bound: SocketAddr) -> SocketAddr {
    if bound.ip().is_unspecified() {
        bound.set_ip(match bound.ip() {
            IpAddr::V4(_) => Ipv4Addr::LOCALHOST.into(),
            IpAddr::V6(_) => Ipv6Addr::LOCALHOST.into(),
        });
    }
    bound
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()?)
}

/// Control traffic only targets the registration's literal local socket address.
pub async fn control(registration: &Registration, action: &str) -> Result<serde_json::Value> {
    let client = client()?;
    let url = format!("{}/api/service/{action}", registration.control_url());
    let request = if action == "status" {
        client.get(url)
    } else {
        client.post(url)
    };
    Ok(request
        .bearer_auth(&registration.control_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// Discover by an authenticated probe, never by assuming a PID still belongs to us.
pub async fn discover(store: &Store) -> Result<Option<Registration>> {
    let store = store.clone();
    let Some(registration) = tokio::task::spawn_blocking(move || store.registration()).await??
    else {
        return Ok(None);
    };
    match control(&registration, "status").await {
        Ok(status) if status["pid"].as_u64() == Some(u64::from(registration.pid)) => {
            Ok(Some(registration))
        }
        _ => Ok(None),
    }
}

/// Status distinguishes a stopped service from an unresponsive lock owner.
pub async fn status(store: &Store) -> Result<Option<Registration>> {
    let found = discover(store).await?;
    if found.is_none() {
        let store = store.clone();
        let running = tokio::task::spawn_blocking(move || store.lock_held()).await??;
        anyhow::ensure!(
            !running,
            "web service is starting or unresponsive; retry shortly and inspect service.log"
        );
    }
    Ok(found)
}

/// Start a detached executable and wait for its authenticated readiness probe.
pub async fn start(store: &Store, config: &ServiceConfig) -> Result<Registration> {
    if let Some(url) = &config.public_url {
        public_url(url)?;
    }
    if let Some(running) = discover(store).await? {
        anyhow::ensure!(
            running.config == *config,
            "web service is running with different settings; use `alnair web restart` with the new options"
        );
        return Ok(running);
    }
    let store_for_log = store.clone();
    let log = tokio::task::spawn_blocking(move || -> Result<File> {
        store_for_log.prepare()?;
        let path = store_for_log.log_path();
        refuse_symlink(&path)?;
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        ensure_owner_only_permissions(&path)?;
        Ok(file)
    })
    .await??;
    #[cfg(unix)]
    let mut child = {
        let mut command = Command::new(std::env::current_exe()?);
        command.args(["web", "--serve-service", "--bind", &config.bind.to_string()]);
        if let Some(url) = &config.public_url {
            command.args(["--public-url", url]);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            // setsid detaches from the controlling terminal, so closing it does not send SIGHUP.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        command
            .spawn()
            .context("could not start Alnair web service")?
    };
    #[cfg(windows)]
    let mut child =
        super::service_windows::spawn(config, log).context("could not start Alnair web service")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(registration) = discover(store).await? {
            std::thread::spawn(move || {
                if let Err(error) = child.wait() {
                    warn!(%error, "web: failed to reap service child");
                }
            });
            anyhow::ensure!(
                registration.config == *config,
                "another web service started with different settings"
            );
            return Ok(registration);
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!(
                "web service exited ({status}); see {}",
                store.log_path().display()
            );
        }
        if tokio::time::Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            anyhow::bail!(
                "web service startup timed out; see {}",
                store.log_path().display()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Ask the authenticated instance to shut down; never signal a possibly reused PID.
pub async fn stop(store: &Store) -> Result<()> {
    let Some(registration) = status(store).await? else {
        return Ok(());
    };
    control(&registration, "stop").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let store_for_check = store.clone();
        let control_token = registration.control_token.clone();
        let stopped = tokio::task::spawn_blocking(move || -> Result<bool> {
            Ok(store_for_check
                .registration()?
                .is_none_or(|current| current.control_token != control_token))
        })
        .await??;
        if stopped {
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "web service has not finished shutting down"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_excludes_competing_starters_and_preserves_session_key() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::new(temporary.path().join("web"));
        let lease = store.acquire().unwrap();
        let secret = lease.secret().unwrap();
        assert!(store.acquire().is_err());
        drop(lease);
        assert_eq!(store.acquire().unwrap().secret().unwrap(), secret);
    }

    #[test]
    fn registration_is_removed_before_lease_releases() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::new(temporary.path().join("web"));
        let mut lease = store.acquire().unwrap();
        lease
            .register(&Registration {
                pid: 123,
                bound: "127.0.0.1:2420".parse().unwrap(),
                config: ServiceConfig::default(),
                control_token: "secret".into(),
            })
            .unwrap();
        assert!(store.registration().unwrap().is_some());
        drop(lease);
        assert!(store.registration().unwrap().is_none());
    }

    #[tokio::test]
    async fn held_lock_without_registration_is_not_reported_as_stopped() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::new(temporary.path().join("web"));
        let lease = store.acquire().unwrap();
        assert!(status(&store).await.is_err());
        drop(lease);
        assert!(status(&store).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn credential_symlinks_are_refused() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::new(temporary.path().join("web"));
        let lease = store.acquire().unwrap();
        let outside = temporary.path().join("outside");
        fs::write(&outside, "untouched").unwrap();
        std::os::unix::fs::symlink(&outside, store.root.join("auth.json")).unwrap();
        assert!(lease.secret().is_err());
        assert!(store.rotate_secret().is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
    }
}
