pub mod conversation;
pub mod error;
pub mod types;

pub use self::conversation::*;
pub use self::error::{ResponseModelMetadata, Result, SamplingError};
pub use self::types::*;
pub use alnair_sampler::ApiBackend;
pub use alnair_sampler::SamplingClient as Client;

pub use async_openai::types::responses as rs;

// The streaming / retry / HTTP-client logic lives in `alnair-sampler`; these
// re-exports keep `crate::sampling::{SamplerHandle, SamplerConfig, ...}` paths
// working for callers not yet ported to `alnair_sampler::*` directly.
pub use alnair_sampler::{
    InferenceLatencyStats, OriginClientInfo, RequestId, SamplerActor, SamplerConfig, SamplerHandle,
    SamplingChannel, SamplingClient, SamplingErrorInfo, SamplingErrorKind, SamplingEvent,
};
