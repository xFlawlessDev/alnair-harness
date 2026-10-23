# Finding — `[memory]` does not hot-reload into a running session

**Status:** unverified against intent; needs a decision, nothing changed.
**Scope:** `[memory]` config only. `[skills]`, `[compat]`, `[platforms.*]`,
`[model.*]`, `[mcp_servers]` and the `AGENTS.md` family are out of scope — those
have working reload paths.
**Origin:** found while designing the workspace lesson library
(`docs/HANDOVER-lesson-library.md`), which needed a hot-reload precedent to
copy. `[memory]` looked like one and turned out not to be.

This document is self-contained. It records what the code does today, where the
documentation disagrees, and what the options are. It deliberately does not
prescribe a fix.

---

## 1. The claim in the docs

`crates/codegen/alnair-tui/docs/user-guide/05-configuration.md:29-35`:

```markdown
Most of `config.toml` is picked up live. Alnair watches the file and re-applies
these sections on save, in every mode (leader, `--no-leader`, and
`alnair agent stdio`):

| Section | Applies live |
|---|---|
| `[mcp_servers]` | yes — servers are restarted with the new config |
| `[platforms.*]`, `[model.*]`, `[models]` | yes — the model catalog is re-resolved |
| `[skills]`, `[compat]`, `[memory]` | yes |
```

The intro sentence makes the claim specific: re-applied **on save**, in **every
mode**. That is what this document tests.

## 2. What the code actually does

### 2.1 The event is produced correctly

`crates/codegen/alnair-shell/src/config/reloader.rs:356-373` re-resolves the
memory config from the old and new TOML on every reload and sends the diff:

```rust
let old_mem = crate::config::MemoryConfig::resolve(
    self.experimental_memory,
    self.no_memory,
    &self.last_global_config,
    self.remote_settings.as_ref(),
);
let new_mem = crate::config::MemoryConfig::resolve(
    self.experimental_memory,
    self.no_memory,
    &new_global,
    self.remote_settings.as_ref(),
);
if old_mem != new_mem {
    info!("memory config change detected");
    let _ = self
        .config_update_tx
        .send(ConfigUpdate::Memory(Box::new(new_mem)));
}
```

So the watcher, the debounce, the diff and the `CLI`-flag plumbing all work.
The failure is downstream.

### 2.2 Both consumers discard the payload

`ConfigUpdate::Memory` has exactly two consumers, one per transport, and both
only log. The in-process transport
(`agent/app.rs:236`, `run_config_update_dispatch_direct`):

```rust
ConfigUpdate::Memory(mem) => {
    info!(
        enabled = mem.enabled,
        "Memory config change detected by watcher"
    );
    None                       // <- no request to dispatch
}
```

The leader / stdio transport (`agent/app.rs:472`,
`run_config_update_dispatch`):

```rust
ConfigUpdate::Memory(mem) => {
    info!(
        enabled = mem.enabled,
        "Memory config change detected by watcher"
    );
}
```

Contrast the sibling arm three lines below, which does dispatch:

```rust
ConfigUpdate::Skills(skills) => {
    info!(paths = skills.paths.len(), "Skills config change detected by watcher");
    Some(("alnair/internal/reload_skills", serde_json::json!({})))
}
```

`None` and the absence of a `Some(...)` are the whole bug: the event is
received, logged, and dropped.

### 2.3 There is no handler to dispatch to

For completeness — adding `Some(("alnair/internal/reload_memory", …))` would
not work on its own:

- `alnair/internal/reload_memory` is not in the extension dispatcher's match
  (`agent/mvp_agent/acp_agent.rs:2140-2147` lists `reload_all_mcp_servers`,
  `reload_project_mcp_servers`, `reload_skills`,
  `reload_project_instructions`, `reload_models`, `reload_models_cache`).
- There is no `handle_reload_memory` in `extensions/session_admin.rs`.
- There is no `SessionCommand::ReloadMemory` in `session/commands.rs`.
- No session-side re-read exists (compare
  `reload_skills_from_disk`, `session_setup.rs:273`).

The chain is absent at every link.

### 2.4 The actor snapshots at spawn and never re-reads

`spawn_session_actor` takes `memory_config: Option<MemoryConfig>`
(`acp_session_impl/spawn.rs:137`) and derives everything from it once:

| derived value | line |
|---|---|
| `memory_storage_for_session` | `:566` |
| `memory_initial_injection_config` | `:580` |
| `SessionMemory.flush_config` | `:1045` |
| `SessionMemory.storage` | `:1054` |
| `SessionMemory.save_on_end` | `:1055` |
| `SessionMemory.initial_injection_config` | `:1059` |
| `SessionMemory.dream_config` | `:1069` |
| `idle_flush_timeout` | `:1083` |

Nothing on `SessionActor` re-reads config after construction. `SessionMemory`
holds no config handle — only the derived values.

### 2.5 What *does* update, and when

`MvpAgent::memory_config` is not frozen for the process lifetime. It is
refreshed on **session creation**:

```
new_session (acp_agent.rs:599)
  -> refresh_settings_and_reapply (agent_ops.rs:680)
       -> re_resolve_runtime_fields (config.rs:1715)
            -> resolve_runtime_fields -> self.memory_config = ...
```

and seeds sessions created afterwards via `self.memory_config.clone()`
(`agent_ops.rs:2639`). So the accurate statement is:

| action | effect on `[memory]` |
|---|---|
| edit `config.toml` while a session runs | **none** — the event is dropped |
| create a new session in the same process | **applies** — `new_session` re-resolves first |
| restart the process | applies |
| `/memory on\|off` | toggles the live actor's `SessionMemory`, independent of config (`slash_exec.rs:647`) |

### 2.6 Why no test caught it

`config/reloader.rs:951-968` has two tests, `memory_config_diff_detects_enabled_change`
and `memory_config_diff_detects_search_param_change`. Both assert only that
`MemoryConfig::resolve` produces different values for different TOML — i.e.
that step 2.1 works. Neither asserts that a consumer *acts* on the event.

That is the structural gap: the reloader side is tested, the application side is
not, and the doc claim sits exactly in the untested space between them.

## 3. Why this matters beyond a doc typo

Three concrete consequences, in increasing severity:

1. **The doc misleads.** A user who edits `[memory.search]` expecting the
   change to take effect on a long-running session gets silence — not even a
   warning that a restart is needed.
2. **It is a bad template.** Any new config section that copies `[memory]` as
   "the section-with-a-live-reload precedent" inherits the same inert arm. The
   workspace lesson library hit this exact trap.
3. **`[memory]` has the largest hot-reload surface of any section.** It carries
   `enabled`, `search.*`, `initial_injection.*`, `embedding.*`, `watcher.*`,
   `dream.*`, `gc.*` and the two `[compaction.*]` sub-tables. All of them are
   inert. The watcher sub-table is the sharpest case: `[memory.watcher]`
   configures watching *memory files* for external edits, so a user editing it
   reasonably expects the watcher itself to be reconfigured — and it is not.

## 4. Options (not a recommendation)

### Option A — make it true

Wire the missing chain, mirroring `[skills]`:

| # | file | change |
|---|---|---|
| 1 | `agent/app.rs:236` and `:472` | arm returns `Some(("alnair/internal/reload_memory", json!({})))` |
| 2 | `mvp_agent/acp_agent.rs:2140` | register the method on the `session_admin::handle` arm |
| 3 | `extensions/session_admin.rs` | `handle_reload_memory` — fan out to all sessions |
| 4 | `session/commands.rs` | `SessionCommand::ReloadMemory` |
| 5 | `run_loop.rs` | arm calling the session-side re-read |
| 6 | `session_setup.rs` | `reload_memory_config_from_disk()` beside `reload_skills_from_disk` |
| 7 | `SessionMemory` | needs a live config handle, or a method that rebuilds the derived fields |

Step 7 is the hard part and the reason this is not a mechanical port of
`[skills]`: skills re-read into a `SkillManager`, whereas memory's config fans
out into eight derived values, two of which (`storage`, `backend_params`)
allocate state and open an index. A live `enabled` flip is closer to
`/memory on|off` than to a re-read.

Decide explicitly which knobs are live-able. A defensible split:

| knob | live? |
|---|---|
| `enabled` | yes — same effect as `/memory on\|off` |
| `search.*`, `initial_injection.*` | yes — read per search / per first turn |
| `flush`, `dream`, `gc` intervals | yes — read by the timers |
| `embedding.*` | **no** — changing dimensions invalidates the index; restart |
| `storage` / `backend_params` construction | **no** — restart |

### Option B — make the doc true by narrowing it

Move `[memory]` out of the "yes" row and into the restart-required sentence,
and say why (the derived-value fan-out). Cost: one doc edit. Cost of being
wrong: a user who wanted live memory config has to restart, which is the
current behavior anyway — so this option is strictly honest and strictly
smaller.

### Option C — warn instead of applying

Keep the arm inert but emit a user-visible notice (`[memory] changes need a new
session`) when the diff fires. Cheapest honest option if Option A's step 7 is
deferred, but it adds a notification path that has no other consumer.

## 5. Open questions for the next session

1. **Was this ever intended to work?** Commit `970521d` ("feat(config):
   hot-reload config, AGENTS.md and skills, and fix Windows") introduced the
   arm. Its body lists four gaps it closed (platforms, dispatcher endpoints,
   watcher-only-under-leader, skills cwd snapshot) and does not mention memory.
   The arm may have been a deliberate placeholder — the `info!` and the explicit
   `None` read like one — or an oversight. **The commit message is the only
   evidence available; decide from it, not from the code's shape.**
2. **Does `refresh_settings_and_reapply` on `new_session` count as "live"?** If
   the intended contract was always "new session picks it up", then only the doc
   is wrong and Option B is the whole fix.
3. **Is `[memory.watcher]` special?** It configures watching memory files for
   external edits. If a user edits it expecting the watcher to be reconfigured,
   that is a distinct sub-bug from the general config-inertness.
4. **What should a mid-session `enabled` flip do to existing state?** Turning
   memory off while a flush is in flight, or while the index is open, needs a
   defined behavior before Option A step 7 can be written.

## 6. Verified anchors

Every claim above was read in this tree. Use symbols, not line numbers.

| symbol | location |
|---|---|
| `ConfigUpdate::Memory` produced | `config/reloader.rs:356-373` |
| consumer, direct transport | `agent/app.rs:236` (`None`) |
| consumer, stream transport | `agent/app.rs:472` (no dispatch) |
| working sibling | `agent/app.rs:241` (`Skills` → `Some(...)`) |
| extension dispatch list | `agent/mvp_agent/acp_agent.rs:2140-2147` |
| skills fan-out precedent | `extensions/session_admin.rs:246` |
| `SessionCommand::ReloadSkills` | `session/commands.rs:600` |
| session-side re-read precedent | `session/acp_session_impl/session_setup.rs:273` |
| `memory_config` param at spawn | `session/acp_session_impl/spawn.rs:137` |
| derived values | `spawn.rs:566, 580, 1045, 1054, 1055, 1059, 1069, 1083` |
| agent-level refresh | `agent/mvp_agent/acp_agent.rs:599` → `agent_ops.rs:680` → `config.rs:1715` |
| `/memory on\|off` | `session/acp_session_impl/slash_exec.rs:647` |
| the two reloader tests | `config/reloader.rs:951`, `:960` |
| the doc claim | `alnair-tui/docs/user-guide/05-configuration.md:29-35` |

## 7. Out of scope, stated so it is not re-investigated

`[skills]`, `[compat]`, `[platforms.*]`, `[model.*]`, `[models]`,
`[mcp_servers]`, `[ui]`, and the `AGENTS.md` family all have working reload
paths and were traced far enough to confirm it. This document is about
`[memory]` alone.

The workspace lesson library (`docs/HANDOVER-lesson-library.md`) does **not**
depend on this finding: it copies the `[skills]` chain, which works. Delete or
promote this document once `[memory]` is decided either way.
