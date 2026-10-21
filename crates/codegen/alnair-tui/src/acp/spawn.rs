//! Agent spawning — creates the agent process and ACP channels.
//!
//! Only AlnairShell (in-process) mode is supported; subprocess and remote modes
//! can be added later if needed.

use std::rc::Rc;
use std::thread;

use anyhow::Result;
use tokio_util::sync::CancellationToken;

use alnair_acp_lib::{
    AcpAgentChannel, AcpClientChannel, AcpClientTx, AcpGatewayReceiver, AcpGatewaySender,
    acp_channels,
};
use alnair_shell::{
    agent::{MvpAgent, config::Config as AgentConfig, models::RefreshStrategy},
    auth::AuthManager,
    util::alnair_home::alnair_home,
};

/// Result of spawning a child agent.
pub struct SpawnedAgent {
    /// Kept alive so the thread isn't detached. Will be used for graceful shutdown.
    pub _thread_handle: thread::JoinHandle<Result<()>>,
    pub channel: AcpClientChannel,
    pub cancel: CancellationToken,
    /// The agent's `AuthManager`, shared so pager-side consumers resolve the
    /// same refreshing bearer as chat traffic.
    pub auth_manager: std::sync::Arc<AuthManager>,
}

/// Spawn an AlnairShell agent in a background thread.
pub async fn spawn_alnair_shell(
    agent_config: AgentConfig,
    cancel: &CancellationToken,
    memory_config: Option<alnair_shell::config::MemoryConfig>,
) -> Result<SpawnedAgent> {
    let auth_manager = std::sync::Arc::new(AuthManager::new(
        &alnair_home(),
        agent_config.kimi_code_config.clone(),
    ));
    auth_manager.configure_refresher();
    // Pause token refreshes across system sleep so an OIDC refresh can't
    // straddle a suspend (which can revoke the refresh token and force
    // re-login). No-op where the OS listener is unavailable.
    auth_manager.start_system_power_listener();

    // Best-effort refresh of managed policy before bootstrap reads it (repairs a wrong-identity/missing
    // cache). Never errors — the OS-protected system/MDM layers still apply.
    alnair_shell::managed_config::ensure_managed_policy_present(&auth_manager).await;

    // Run the full bootstrap sequence: config resolution, process-level
    // singletons (including `extract_bundled_files` which writes compiled-in
    // skills to ~/.alnair/skills/), and model catalog construction.
    let (agent_config, models_manager) =
        alnair_shell::agent::init::bootstrap(&agent_config, &auth_manager, None)
            .map_err(|e| anyhow::anyhow!(e))?;
    models_manager
        .list_models(RefreshStrategy::OnlineIfUncached)
        .await;

    let agent_cancel = cancel.child_token();
    let (acp_client, acp_agent) = acp_channels();

    // Clone before `auth_manager` is moved into the agent closure below, so the
    // pager can share the same refreshing bearer.
    let auth_manager_for_pager = auth_manager.clone();

    // Config hot-reload for the in-process transport. There is no ACP inbound
    // simplex here, so the watcher's updates are dispatched DIRECTLY against
    // the agent (`run_config_update_dispatch_direct`) rather than injected as
    // request lines. Without this, `--no-leader` had no hot-reload at all.
    let cwd_for_watcher = std::env::current_dir().unwrap_or_default();
    let hot_reload_cancel = agent_cancel.clone();
    let hot_reload = alnair_shell::agent::app::start_config_hot_reload(
        &agent_config,
        &cwd_for_watcher,
        &hot_reload_cancel,
    );
    let auth_manager_for_reload = auth_manager.clone();
    let models_manager_for_reload = models_manager.clone();

    // Skills hot-reload, same transport split as config: direct dispatch, no
    // inbound stream. Previously only leader and `agent stdio` had this, so
    // adding a skill under `--no-leader` needed a restart.
    let skills_watch =
        alnair_shell::agent::app::start_skills_watch_direct(&agent_config.skills.paths);

    let spawn_fn: Box<dyn FnOnce(AcpClientTx) -> Result<Rc<MvpAgent>> + Send + 'static> = {
        Box::new(move |client_tx| {
            let gateway = AcpGatewaySender::new(client_tx);

            let mut agent =
                MvpAgent::with_models(gateway, &agent_config, auth_manager, models_manager);
            if let Some(mc) = memory_config {
                agent.set_memory_config(mc);
            }
            let agent = Rc::new(agent);

            // The dispatch task must live on the agent's thread: `MvpAgent` is
            // `!Send`, so the update receiver is moved into the closure and
            // driven here, on the same LocalSet that runs the agent.
            if let Some((watcher, updates)) = hot_reload {
                let agent_for_reload = agent.clone();
                tokio::task::spawn_local(async move {
                    // Hold the watcher for the task's lifetime; dropping it
                    // stops the OS watches.
                    let _watcher = watcher;
                    alnair_shell::agent::app::run_config_update_dispatch_direct(
                        updates,
                        auth_manager_for_reload,
                        models_manager_for_reload,
                        agent_for_reload,
                    )
                    .await;
                });
            }

            if let Some((watcher, mut skills_rx)) = skills_watch {
                let agent_for_skills = agent.clone();
                tokio::task::spawn_local(async move {
                    let _watcher = watcher;
                    while skills_rx.recv().await.is_some() {
                        tracing::info!("Skill directory changed on disk, reloading skills");
                        if let Err(e) = agent_for_skills
                            .dispatch_internal(
                                "alnair/internal/reload_skills",
                                serde_json::json!({}),
                            )
                            .await
                        {
                            tracing::warn!(
                                error = ?e,
                                "in-process skills reload dispatch failed"
                            );
                        }
                    }
                });
            }
            Ok(agent)
        })
    };

    let handle = spawn_agent_thread_direct(spawn_fn, acp_agent, agent_cancel.clone())?;

    Ok(SpawnedAgent {
        _thread_handle: handle,
        channel: acp_client,
        cancel: agent_cancel,
        auth_manager: auth_manager_for_pager,
    })
}

/// Spawn an agent in a dedicated thread with direct RPC dispatch.
///
/// The agent runs on a single-threaded tokio LocalSet runtime.
/// RPC requests go directly to the agent via Rc, bypassing simplex pipes.
fn spawn_agent_thread_direct(
    spawn_agent: Box<dyn FnOnce(AcpClientTx) -> Result<Rc<MvpAgent>> + Send + 'static>,
    channel: AcpAgentChannel,
    cancel: CancellationToken,
) -> Result<thread::JoinHandle<Result<()>>> {
    Ok(thread::Builder::new()
        .name("acp-agent-worker".into())
        .spawn(move || -> Result<()> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, async move {
                let client_tx = channel.tx.clone();
                let agent_rc = spawn_agent(client_tx)?;

                let gw_rx = AcpGatewayReceiver::new(channel.rx, agent_rc).with_tracing(true);
                tokio::task::spawn_local(gw_rx.run());
                tokio::task::yield_now().await;

                cancel.cancelled().await;
                anyhow::Result::Ok(())
            })
        })?)
}
