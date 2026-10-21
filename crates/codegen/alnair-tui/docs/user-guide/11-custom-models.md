# Custom Models

Alnair connects to custom model endpoints for alternative providers, self-hosted models, and overriding built-in settings. This guide explains how to select models, configure endpoints, and integrate third-party providers.

---

## Default Models

By default, Alnair uses models hosted by SpaceXAI, and new sessions start with `alnair`. Default models require no configuration. Authenticate with `alnair login` or an API key, then start a session.

List all available models:

```bash
alnair models
```

---

## Selecting a Model

### CLI Flag

```bash
alnair -p "Hello" -m alnair
```

### Slash Command

In the TUI, switch models during a session:

```
/model alnair
```

Or use the alias:

```
/m alnair
```

### Model Picker (Ctrl+M)

Press `Ctrl+M` from the scrollback pane to open the model picker. It lists all available models, both built-in and custom, and lets you switch with a single keystroke. With the prompt focused, `Ctrl+M` toggles multiline input instead -- use `/model` to switch without leaving the prompt.

### Config Default

Set a persistent default in `~/.alnair/config.toml`:

```toml
[models]
default = "alnair"
```

---

## Supported API Backends

Alnair supports three API backends. Set `api_backend` in your `[model.*]` config to choose which protocol the model uses:

| Value | API | Default |
|-------|-----|---------|
| `"chat_completions"` | OpenAI Chat Completions (`/v1/chat/completions`) | Yes |
| `"responses"` | OpenAI Responses (`/v1/responses`) | |
| `"messages"` | Anthropic Messages (`/v1/messages`) | |

When you omit `api_backend`, Alnair uses `chat_completions`.

To send provider-specific authentication or version headers -- for example, Anthropic's `x-api-key` -- use the `extra_headers` field described below. Alnair sends those headers verbatim with every request to the endpoint.

---

## Configuring Custom Models

Add custom model endpoints in `~/.alnair/config.toml` under `[model.<name>]` sections:

```toml
[model.my-model]
model = "model-id"                        # Model identifier sent to the API
base_url = "https://api.example.com/v1"   # OpenAI-compatible endpoint
name = "Display Name"                     # Shown in the model picker
description = "Model description"          # Optional description
api_key = "sk-..."                        # API key for this provider (optional)
env_key = "XAI_API_KEY"                   # Env var holding the API key (optional; string or array)
api_backend = "chat_completions"          # "chat_completions", "responses", or "messages"
temperature = 0.7                         # Sampling temperature
top_p = 0.95                              # Nucleus sampling parameter
max_completion_tokens = 8192              # Maximum tokens per response
context_window = 128000                   # Total context window in tokens
extra_headers = { "x-api-key" = "sk-..." } # Extra request headers, sent verbatim (optional)
```

### Credential Resolution

Alnair resolves the API key in this order:

1. The `api_key` field in the model config
2. The environment variable(s) named by `env_key` — a single string or an array of names. The first set, non-empty value wins (for example `env_key = ["ANTHROPIC_AUTH_TOKEN", "LC_ANTHROPIC_AUTH_TOKEN"]` for SSH `LC_*` forwarding)
3. Your signed-in session token (from `alnair login`), for a model with no `api_key`/`env_key` of its own
4. The `XAI_API_KEY` environment variable (global fallback; Alnair also accepts `ALNAIR_CODE_XAI_API_KEY` for backward compatibility)

### Context Window

The `context_window` value tells Alnair when to trigger auto-compaction. When you override a known model, Alnair inherits that model's context window. When you define a new model and omit `context_window`, Alnair defaults to 200,000 tokens, so set it explicitly to match your provider.

### Global Default Headers

To apply the same headers to *every* model in the catalog -- built-in, prefetched from `/v1/models`, or custom -- set them once under the global `[models]` section instead of repeating them per model:

```toml
[models]
extra_headers = { "X-Request-Tags" = "team=example,env=prod" }
```

These act as a base for each model's inference requests. A per-model `[model.<id>].extra_headers` entry overrides the global default **per key** (matched case-insensitively): a key set on the model wins, while any global-only keys are still inherited by that model. Like the per-model field, they ride on that model's inference calls -- not on separate services such as image generation or video generation -- which makes them handy for attribution tags (for example, cost tracking) without re-declaring them whenever a new model appears.

### Global Default Values

A few common per-model settings can also be set once under `[models]` as a default for *every* model. A per-model `[model.<id>]` value always wins; the global only fills in where a model (or the server's model list) left the field unset:

```toml
[models]
temperature                 = 0.7
top_p                       = 0.95
max_completion_tokens       = 8192
max_retries                 = 8
inference_idle_timeout_secs = 600
stream_tool_calls           = true
```

This is a small, fixed set of environment-wide knobs. Settings that identify a specific model (`model`, `base_url`, `api_key`, `context_window`, ...) cannot be defaulted this way, and a few settings with their own dedicated configuration -- auto-compaction (`[session]`), the system-prompt label (`[agent]`), and reasoning effort (`[models].default_reasoning_effort`) -- keep their existing homes.

> **Note on `stream_tool_calls`:** this one affects request *shape*, not just sampling. A few endpoints (some BYOK providers) expect it left unset; if a global `stream_tool_calls = true` causes problems for such a model, opt that model out with `stream_tool_calls = false` in its `[model.<id>]` block.

### Shared Capability and Reasoning-Effort Menus

Two more list-valued settings can be declared once under `[models]` and inherited by every model that declares none of its own: `capabilities` and `reasoning_efforts`.

```toml
[models]
capabilities      = ["thinking"]
reasoning_efforts = ["low", "medium", "high", "max"]
```

Without this, a fleet of custom models sharing one menu had to repeat the whole block per model:

```toml
# Before: identical six-line block repeated for every model
[[model."alnair/deepseek-v4-1-flash".reasoning_efforts]]
value = "low"
label = "Low"

[[model."alnair/deepseek-v4-1-flash".reasoning_efforts]]
value = "max"
label = "Max"
# ...and again for openscale-deepseek, glm-5-3, ...

# After: declare it once, then only what differs per model
[model."alnair/deepseek-v4-1-flash"]
context_window = 1000000

# A model that wants a different menu still just says so:
[model."alnair/legacy-model"]
reasoning_efforts = ["none", "medium"]
```

The inheritance rule matches the other global defaults: a per-model `[model.<id>]` list always wins outright, and the global only fills in a model that left the field empty. Because an empty list and an unset list are indistinguishable for an array, `[models]` is the only place a *default* can be expressed -- a model with no menu inherits it, and there is no way to opt a single model out other than giving it its own list.

Two notes on the reasoning-effort menu:

- Each entry may be a bare string (`"high"`) or a table (`{ value = "high", label = "High", default = true }`). Bare strings get an auto-capitalized label, and the *first* entry becomes the default when none is marked `default`.
- `[models] default_reasoning_effort` is a separate setting: it picks which effort a model **starts** at, while `reasoning_efforts` declares which efforts it **offers**. Set both if you want a starting point other than the first menu entry.

---

## Overriding Built-in Models

You can override specific fields of built-in models without redefining everything. Only specify the fields you want to change:

```toml
# Override only the API key for a default model
[model.alnair-build]
api_key = "my-api-key"

# Override temperature and add a custom API key
[model.alnair-build]
temperature = 0.5
api_key = "sk-custom"
```

When you override a built-in model, Alnair starts with the default configuration (including the correct `base_url`), then applies only the fields you specify. Unspecified fields inherit from the default.

### Priority Order

1. Your config (`[model.*]`) -- highest priority
2. Prefetched models from remote `/v1/models`
3. Hardcoded defaults -- lowest priority

---

## Provider Examples

### Anthropic (Claude)

Use Claude models directly via the Anthropic Messages API:

```toml
[model.claude-opus]
model = "claude-opus-4-6"
base_url = "https://api.anthropic.com/v1"
name = "Claude Opus 4.6"
api_backend = "messages"
context_window = 200000
extra_headers = { "x-api-key" = "sk-ant-...", "anthropic-version" = "2023-06-01" }
```

The `messages` backend uses the Anthropic Messages protocol. Anthropic authenticates with an `x-api-key` header rather than `Authorization: Bearer`, so pass your key through `extra_headers`, which Alnair sends verbatim.

### OpenAI (Chat Completions)

```toml
[model.gpt-4o]
model = "gpt-4o"
base_url = "https://api.openai.com/v1"
name = "GPT-4o"
env_key = "OPENAI_API_KEY"
```

`api_backend` defaults to `"chat_completions"`, so you don't need to set it explicitly for OpenAI.

### OpenAI (Responses API)

If your provider supports the newer Responses API:

```toml
[model.gpt-4o-responses]
model = "gpt-4o"
base_url = "https://api.openai.com/v1"
name = "GPT-4o (Responses)"
api_backend = "responses"
env_key = "OPENAI_API_KEY"
```

### Ollama (Local Models)

Run models locally with [Ollama](https://ollama.ai):

```toml
[model.ollama-codellama]
model = "codellama"
base_url = "http://localhost:11434/v1"
name = "CodeLlama (Ollama)"
```

Make sure Ollama is running (`ollama serve`) and the model is pulled (`ollama pull codellama`).

### Together AI

```toml
[model.together-mixtral]
model = "mistralai/Mixtral-8x7B-Instruct-v0.1"
base_url = "https://api.together.xyz/v1"
name = "Mixtral 8x7B"
env_key = "TOGETHER_API_KEY"
```

### Local OpenAI-Compatible Server

Any server that implements the OpenAI Chat Completions or Responses API:

```toml
[model.local-llama]
model = "llama-3.1-70b"
base_url = "http://localhost:8080/v1"
name = "Local Llama"
temperature = 0.8
```

---

## Custom Models Endpoint

Point Alnair at a custom OpenAI-compatible `/v1/models` endpoint instead of the default. Use this when your models sit behind a corporate gateway or a self-hosted inference service.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ALNAIR_MODELS_BASE_URL` | Yes | Base URL for inference. Alnair fetches the model list from `{base_url}/models`. |
| `XAI_API_KEY` | Yes | API key sent as `Authorization: Bearer`. Alnair also accepts `ALNAIR_CODE_XAI_API_KEY`. |
| `ALNAIR_MODELS_LIST_URL` | No | Override the model-list URL when it differs from `{base_url}/models`. |

### Setup

```bash
export ALNAIR_MODELS_BASE_URL="https://api.acme.com/v1"
export XAI_API_KEY="xai-..."
alnair
```

### Config File Alternative

```toml
[endpoints]
models_base_url = "https://api.acme.com/v1"

# Override only the API key for a specific model
[model.alnair-build]
api_key = "my-api-key"
```

When you use `[endpoints]` with partial model overrides, Alnair inherits the `base_url` from the endpoints config, so you do not need to specify it in each `[model.*]` section.

### Auth Behavior

When you set `models_base_url`, Alnair uses API key auth (`Authorization: Bearer`) instead of session auth. You do not need `alnair login` -- the API key is enough.

---

## Using Custom Models

```bash
# List available models (including custom)
alnair models

# Use in the TUI via slash command
/model my-model

# Use in headless mode
alnair -p "Hello" -m my-model

# Set as default in config.toml:
[models]
default = "my-model"
```

---

## Enterprise Deployment

A complete config for an enterprise deployment with custom models:

```toml
[cli]
auto_update = false

[auth]
auth_provider_command = "/usr/local/bin/my-company-auth-provider"
auth_provider_label = "Acme Corp"
auth_token_ttl = 3600

[models]
default = "company-alnair"

[model.company-alnair]
model = "alnair"
base_url = "https://alnair-proxy.acme.com/"
name = "Alnair Latest (Proxy)"
context_window = 128000

[features]
telemetry = false
```

---

## Troubleshooting

### Model Not Found

```bash
# List available models
alnair models

# Check config.toml for typos in [model.*] sections
```

### Connection Errors

Verify the endpoint is reachable:

```bash
curl -s https://api.example.com/v1/models \
  -H "Authorization: Bearer $XAI_API_KEY"
```

### Debug Logging

```bash
RUST_LOG=debug ALNAIR_LOG_FILE=/tmp/alnair.log alnair
tail -f /tmp/alnair.log
```

Look for log entries containing `model` or `sampling` to trace model selection and API calls.
