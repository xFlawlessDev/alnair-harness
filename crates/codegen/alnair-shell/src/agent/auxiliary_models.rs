//! Optional model selections for background requests. Unset selections inherit chat.

use super::config::ModelsConfig;

/// The purpose of a model override under `[models]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxiliaryModel {
    SessionTitle,
    ImageDescription,
    PromptSuggestion,
    ShellSuggestion,
    MemoryRewrite,
}

impl AuxiliaryModel {
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.key() == key)
    }

    pub const ALL: [Self; 5] = [
        Self::SessionTitle,
        Self::ImageDescription,
        Self::PromptSuggestion,
        Self::ShellSuggestion,
        Self::MemoryRewrite,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::SessionTitle => "session_summary",
            Self::ImageDescription => "image_description",
            Self::PromptSuggestion => "prompt_suggestion",
            Self::ShellSuggestion => "shell_suggestion",
            Self::MemoryRewrite => "memory_rewrite",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::SessionTitle => "Session title model",
            Self::ImageDescription => "Image description model",
            Self::PromptSuggestion => "Prompt suggestion model",
            Self::ShellSuggestion => "Shell suggestion model",
            Self::MemoryRewrite => "Memory note model",
        }
    }

    pub fn env_var(self) -> &'static str {
        match self {
            Self::SessionTitle => "ALNAIR_SESSION_SUMMARY_MODEL",
            Self::ImageDescription => "ALNAIR_IMAGE_DESCRIPTION_MODEL",
            Self::PromptSuggestion => "ALNAIR_PROMPT_SUGGESTIONS_MODEL",
            Self::ShellSuggestion => "ALNAIR_SHELL_SUGGESTION_MODEL",
            Self::MemoryRewrite => "ALNAIR_MEMORY_REWRITE_MODEL",
        }
    }

    pub fn selection(self, models: &ModelsConfig) -> Option<&str> {
        self.field(models)
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
    }

    /// Includes explicit empty selections, which suppress remote pins.
    pub fn is_configured(self, models: &ModelsConfig) -> bool {
        self.field(models).is_some()
    }

    fn field(self, models: &ModelsConfig) -> &Option<String> {
        match self {
            Self::SessionTitle => &models.session_summary,
            Self::ImageDescription => &models.image_description,
            Self::PromptSuggestion => &models.prompt_suggestion,
            Self::ShellSuggestion => &models.shell_suggestion,
            Self::MemoryRewrite => &models.memory_rewrite,
        }
    }

    pub fn set(self, models: &mut ModelsConfig, selection: Option<String>) {
        let field = match self {
            Self::SessionTitle => &mut models.session_summary,
            Self::ImageDescription => &mut models.image_description,
            Self::PromptSuggestion => &mut models.prompt_suggestion,
            Self::ShellSuggestion => &mut models.shell_suggestion,
            Self::MemoryRewrite => &mut models.memory_rewrite,
        };
        *field = selection;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_selections_survive_serialization_and_follow_chat() {
        let mut models = ModelsConfig::default();
        for kind in AuxiliaryModel::ALL {
            kind.set(&mut models, Some(String::new()));
        }
        let serialized = toml::Value::try_from(&models).unwrap();
        let restored: ModelsConfig = serialized.clone().try_into().unwrap();
        for kind in AuxiliaryModel::ALL {
            assert_eq!(
                serialized.get(kind.key()).and_then(toml::Value::as_str),
                Some("")
            );
            assert_eq!(kind.selection(&restored), None);
        }
    }
}
