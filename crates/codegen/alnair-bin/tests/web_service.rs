//! Detached lifecycle smoke test with a private Alnair home and no model calls.

use std::process::{Command, Output, Stdio};
use std::time::Duration;

struct Service {
    home: tempfile::TempDir,
}

impl Service {
    fn command(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_alnair"));
        command
            .arg("web")
            .args(arguments)
            .env("ALNAIR_SHARE_DIR", self.home.path())
            .env("ALNAIR_MODELS_DEV_URL", "0");
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let _receiver_may_have_timed_out = send.send(command.output());
        });
        match receive.recv_timeout(Duration::from_secs(30)) {
            Ok(output) => {
                reader.join().unwrap();
                output.unwrap()
            }
            Err(error) => {
                // Release any pipes inherited by a regressed detached child before failing.
                let _cleanup = Command::new(env!("CARGO_BIN_EXE_alnair"))
                    .args(["web", "stop"])
                    .env("ALNAIR_SHARE_DIR", self.home.path())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                panic!("web {arguments:?} did not close its captured output: {error}");
            }
        }
    }

    fn run(&self, arguments: &[&str]) -> String {
        let output = self.command(arguments);
        assert!(
            output.status.success(),
            "web {:?}: {}",
            arguments,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn registration(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.home.path().join("web/service.json")).unwrap())
            .unwrap()
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.command(&["stop"]);
    }
}

#[tokio::test]
async fn detached_service_pairs_restarts_revokes_and_stops() {
    let service = Service {
        home: tempfile::tempdir().unwrap(),
    };
    assert!(service.run(&["status"]).contains("stopped"));
    service.run(&["start", "--bind", "127.0.0.1:0"]);
    let first = service.registration();
    let bound = first["bound"].as_str().unwrap();
    assert!(service.run(&["status"]).contains("running"));
    service.run(&["start"]);
    assert_eq!(
        service.registration()["pid"],
        first["pid"],
        "repeated start must adopt the incumbent"
    );

    let client = reqwest::Client::builder()
        .no_proxy()
        // Each request must reach the replacement process after a restart.
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let link_output = service.run(&["pair"]);
    let link = link_output
        .lines()
        .find(|line| line.starts_with("http://") && line.contains("/auth/connect/"))
        .unwrap();
    let paired = client.get(link).send().await.unwrap();
    assert_eq!(paired.status(), reqwest::StatusCode::SEE_OTHER);
    let cookie = paired.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session_url = format!("http://{bound}/api/session");
    assert_eq!(
        client
            .get(&session_url)
            .header(reqwest::header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        client.get(link).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let log = std::fs::read_to_string(service.home.path().join("web/service.log")).unwrap();
    assert!(
        !log.contains("/auth/connect/"),
        "background logs must not contain pairing credentials"
    );

    // Keep the assigned port on restart so the browser's signed cookie has the same audience.
    service.run(&["restart", "--bind", bound]);
    assert_ne!(service.registration()["pid"], first["pid"]);
    assert_eq!(
        client
            .get(&session_url)
            .header(reqwest::header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    service.run(&["revoke"]);
    assert_eq!(
        client
            .get(&session_url)
            .header(reqwest::header::COOKIE, cookie)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    service.run(&["stop"]);
    assert!(service.run(&["status"]).contains("stopped"));
    assert!(!service.home.path().join("web/service.json").exists());

    // Pair itself can restart the saved service after an explicit stop.
    assert!(service.run(&["pair"]).contains("/auth/connect/"));
    service.run(&["stop"]);

    // Proxy pairing prints the configured HTTPS origin and a browser-readable QR.
    service.run(&["start", "--public-url", "https://alnair.example.com"]);
    let proxy_link = service.run(&["pair"]);
    assert!(proxy_link.contains("https://alnair.example.com/auth/connect/"));
    assert!(proxy_link.contains('█') || proxy_link.contains('▀') || proxy_link.contains('▄'));
    let invalid = service.command(&["pair", "--url", "https://attacker.example"]);
    assert!(!invalid.status.success());
    service.run(&["stop"]);
}
