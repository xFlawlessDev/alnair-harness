//! Foreground web server and background service commands.

use alnair_tui::app::{WebArgs, WebCommand};
use alnair_web::{WebServerConfig, auth, run_web_server, service};
use anyhow::{Context as _, Result};
use tokio_util::sync::CancellationToken;

pub async fn run(args: WebArgs) -> Result<()> {
    anyhow::ensure!(
        !args.serve_service || args.command.is_none(),
        "internal service mode cannot be combined with subcommands"
    );
    let store = service::Store::user()?;
    match args.command {
        Some(WebCommand::Status) => {
            match service::status(&store).await? {
                Some(running) => println!(
                    "Alnair web is running (pid {}).\n{}",
                    running.pid,
                    running.browser_url()
                ),
                None => println!("Alnair web is stopped."),
            }
            return Ok(());
        }
        Some(WebCommand::Stop) => {
            service::stop(&store).await?;
            println!("Alnair web is stopped.");
            return Ok(());
        }
        Some(WebCommand::Revoke) => {
            let running = service::status(&store)
                .await?
                .context("web service is stopped; start it with `alnair web start`")?;
            service::control(&running, "revoke").await?;
            println!("All web sessions and outstanding pairing links were revoked.");
            return Ok(());
        }
        _ => {}
    }
    let store_for_config = store.clone();
    let mut settings = tokio::task::spawn_blocking(move || store_for_config.config()).await??;
    if let Some(bind) = args.bind {
        settings.bind = bind;
    }
    if let Some(url) = &args.public_url {
        settings.public_url = Some(auth::public_url(url)?.origin().ascii_serialization());
    }
    match args.command {
        Some(command) => {
            anyhow::ensure!(
                args.pid.is_none() && args.socket.is_none(),
                "leader targeting is only supported by the foreground web server"
            );
            if matches!(command, WebCommand::Restart) {
                service::stop(&store).await?;
            }
            let running = service::start(&store, &settings).await?;
            match command {
                WebCommand::Pair { url } => pair(&running, url.as_deref(), args.open).await?,
                _ => {
                    println!(
                        "Alnair web is running in the background (pid {}).\n{}",
                        running.pid,
                        running.browser_url()
                    );
                    println!("Run `alnair web pair` to connect a browser.");
                    if args.open {
                        pair(&running, None, true).await?;
                    }
                }
            }
        }
        None => {
            let cancel = CancellationToken::new();
            let shutdown = cancel.clone();
            let signal_task = tokio::spawn(async move {
                #[cfg(unix)]
                {
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        Ok(mut terminate) => {
                            tokio::select! {
                                _ = tokio::signal::ctrl_c() => {},
                                _ = terminate.recv() => {},
                            }
                        }
                        Err(error) => {
                            tracing::warn!(%error, "web: SIGTERM handler unavailable");
                            let _ = tokio::signal::ctrl_c().await;
                        }
                    }
                }
                #[cfg(not(unix))]
                if let Err(error) = tokio::signal::ctrl_c().await {
                    tracing::warn!(%error, "web: Ctrl+C handler unavailable");
                    // Detached Windows processes may have no console; HTTP stop still works.
                    std::future::pending::<()>().await;
                }
                shutdown.cancel();
            });
            let result = run_web_server(
                WebServerConfig {
                    bind: settings.bind,
                    public_url: settings.public_url,
                    leader: alnair_web::server::LeaderTarget {
                        pid: args.pid,
                        socket: args.socket,
                    },
                    open: args.open,
                    state_dir: None,
                    background: args.serve_service,
                },
                cancel,
            )
            .await;
            signal_task.abort();
            result?;
        }
    }
    Ok(())
}

async fn pair(running: &service::Registration, origin: Option<&str>, open: bool) -> Result<()> {
    let url = auth::public_url(origin.unwrap_or(&running.browser_url()))?;
    let gate = auth::Gate::new(
        running.bound,
        running
            .config
            .public_url
            .as_deref()
            .map(auth::public_url)
            .transpose()?,
        "",
        String::new(),
    );
    anyhow::ensure!(
        gate.origin_allowed(&url.origin().ascii_serialization()),
        "pairing origin is not served; configure it with `alnair web restart --public-url <origin>`"
    );
    let code = service::control(running, "pair").await?;
    let code = code["code"]
        .as_str()
        .context("server did not return a pairing code")?;
    let link = format!("{}/auth/connect/{code}", url.origin().ascii_serialization());
    println!("Open this link within five minutes. It works once.\n\n{link}\n");
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => name == "localhost" || name.ends_with(".localhost"),
        None => true,
    };
    if !loopback {
        // Browser QR codes carry the URL directly; Alnair has no companion-app format.
        let qr = qrcode::QrCode::new(link.as_bytes())?;
        println!(
            "{}",
            qr.render::<qrcode::render::unicode::Dense1x2>()
                .quiet_zone(true)
                .build()
        );
    } else {
        println!(
            "For LAN access: `alnair web restart --bind 0.0.0.0:{}`",
            running.bound.port()
        );
        println!(
            "Then run `alnair web pair --url http://<server-ip>:{}`.",
            running.bound.port()
        );
        println!(
            "Over SSH: `ssh -L {}:{} <host>`",
            running.bound.port(),
            running.bound
        );
    }
    if open && let Err(error) = webbrowser::open(&link) {
        tracing::warn!(%error, "web: could not open browser; use the printed link");
    }
    Ok(())
}
