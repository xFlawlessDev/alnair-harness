use indexmap::IndexMap;

/// Configuration for the `web_search` tool.
///
/// This is the **enable gate**, not the endpoint: the endpoint is resolved per
/// call from the session's [`crate::types::web_provider::WebTargetProvider`]
/// (carried on `SessionContext`), because a session can switch providers
/// mid-session and a captured URL would keep posting to the provider it started
/// on. `Disabled` means the tool is not registered at all.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WebSearchConfig {
    #[default]
    Disabled,
    Enabled {
        #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
        extra_headers: IndexMap<String, String>,
    },
}

impl WebSearchConfig {
    pub fn is_enabled(&self) -> bool {
        matches!(self, Self::Enabled { .. })
    }

    /// Extra headers for every search request, empty when disabled.
    pub fn extra_headers(&self) -> &IndexMap<String, String> {
        match self {
            Self::Disabled => empty_headers(),
            Self::Enabled { extra_headers } => extra_headers,
        }
    }

    /// A copy safe to return to clients. Nothing credential-bearing lives here,
    /// so this is the identity apart from normalizing `Disabled`.
    pub fn redacted(&self) -> Self {
        self.clone()
    }
}

fn empty_headers() -> &'static IndexMap<String, String> {
    static EMPTY: std::sync::LazyLock<IndexMap<String, String>> =
        std::sync::LazyLock::new(IndexMap::new);
    &EMPTY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default_is_disabled() {
        let config = WebSearchConfig::default();
        assert!(!config.is_enabled());
        assert!(config.extra_headers().is_empty());
    }

    #[test]
    fn test_config_serde_roundtrip() {
        let mut headers = IndexMap::new();
        headers.insert("X-Custom".to_string(), "value".to_string());
        let config = WebSearchConfig::Enabled {
            extra_headers: headers,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WebSearchConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_enabled());
        assert_eq!(
            parsed.extra_headers().get("X-Custom").map(String::as_str),
            Some("value")
        );
    }

    #[test]
    fn redacted_keeps_headers_and_enablement() {
        let mut headers = IndexMap::new();
        headers.insert("X-Custom".to_string(), "value".to_string());
        let config = WebSearchConfig::Enabled {
            extra_headers: headers,
        };
        let redacted = config.redacted();
        assert!(redacted.is_enabled());
        assert_eq!(
            redacted.extra_headers().get("X-Custom").map(String::as_str),
            Some("value")
        );
        assert!(!WebSearchConfig::Disabled.redacted().is_enabled());
    }
}
