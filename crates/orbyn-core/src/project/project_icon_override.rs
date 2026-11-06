//! Project display metadata validation, independent of execution and file grants.
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};
use orbyn_contracts::ProjectIconOverride;
use unicode_segmentation::UnicodeSegmentation;

use crate::error::{CoreError, Result};

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    })
}

fn text(value: &str, max: usize) -> Result<String> {
    let value = js_trim(value);
    if value.is_empty() || value.encode_utf16().count() > max {
        return Err(CoreError::Invalid("Invalid project icon text.".into()));
    }
    Ok(value.to_owned())
}

fn checked(icon: &ProjectIconOverride, command: bool) -> Result<ProjectIconOverride> {
    Ok(match icon {
        ProjectIconOverride::Lucide { name, color } => {
            let name = text(name, 64)?;
            if name.split('-').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            }) {
                return Err(CoreError::Invalid("Invalid project icon name.".into()));
            }
            ProjectIconOverride::Lucide {
                name,
                color: *color,
            }
        }
        ProjectIconOverride::Emoji { emoji } => ProjectIconOverride::Emoji {
            emoji: text(emoji, 32)?,
        },
        ProjectIconOverride::Monogram { text: value, color } => {
            let value = text(value, 32)?;
            let categories = CodePointMapData::<GeneralCategory>::new();
            let mut points = value.chars();
            let letter_or_number = |point| {
                let category = categories.get(point);
                GeneralCategoryGroup::Letter.contains(category)
                    || GeneralCategoryGroup::Number.contains(category)
            };
            if !points.next().is_some_and(letter_or_number)
                || !points.all(|point| {
                    letter_or_number(point)
                        || GeneralCategoryGroup::Mark.contains(categories.get(point))
                        || matches!(point, '\u{200c}' | '\u{200d}')
                })
                || (command && value.graphemes(true).take(3).count() > 2)
            {
                return Err(CoreError::Invalid("Invalid project monogram.".into()));
            }
            ProjectIconOverride::Monogram {
                text: value,
                color: *color,
            }
        }
    })
}

pub(crate) fn validate(icon: &ProjectIconOverride) -> Result<ProjectIconOverride> {
    checked(icon, true)
}

/// Unknown future variants are display fallbacks; malformed known values are errors.
pub(crate) fn read_stored(text: &str) -> Result<Option<ProjectIconOverride>> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Invalid("Invalid stored project icon.".into()))?;
    if !matches!(kind, "lucide" | "emoji" | "monogram") {
        return Ok(None);
    }
    let icon: ProjectIconOverride = serde_json::from_value(value)?;
    checked(&icon, false).map(Some)
}

pub(crate) fn revision(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0 && n.to_string() == value)
        .ok_or(CoreError::SettingsConflict)
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbyn_contracts::ProjectIconColor;
    #[test]
    fn typed_icons_preserve_server_text_and_exact_unicode_boundaries() {
        let color = ProjectIconColor::Blue;
        for value in ["ab", "e\u{301}", "𐐀𐐁", "क्‍ष", "a\u{200c}"] {
            assert!(
                validate(&ProjectIconOverride::Monogram {
                    text: value.into(),
                    color
                })
                .is_ok(),
                "{value}"
            );
        }
        for value in ["abc", "\u{301}A", "A-B", "💻", "\u{345}A"] {
            assert!(
                validate(&ProjectIconOverride::Monogram {
                    text: value.into(),
                    color
                })
                .is_err(),
                "{value}"
            );
        }
        let value = format!("a{}", "\u{301}".repeat(31));
        assert!(validate(&ProjectIconOverride::Monogram { text: value, color }).is_ok());
        let value = format!("a{}", "\u{301}".repeat(32));
        assert!(validate(&ProjectIconOverride::Monogram { text: value, color }).is_err());
        for value in ["ABC".into(), "💻".repeat(16)] {
            assert!(validate(&ProjectIconOverride::Emoji { emoji: value }).is_ok());
        }
        assert!(
            validate(&ProjectIconOverride::Emoji {
                emoji: "💻".repeat(17)
            })
            .is_err()
        );
        for name in ["future-icon", "arrow-down-0-1"] {
            assert!(
                validate(&ProjectIconOverride::Lucide {
                    name: name.into(),
                    color
                })
                .is_ok()
            );
        }
        for name in ["Foo", "a--b", "_icon", "-icon"] {
            assert!(
                validate(&ProjectIconOverride::Lucide {
                    name: name.into(),
                    color
                })
                .is_err()
            );
        }
        let icon = validate(&ProjectIconOverride::Monogram {
            text: "\u{feff} ab \u{feff}".into(),
            color,
        })
        .unwrap();
        assert_eq!(serde_json::to_value(icon).unwrap()["text"], "ab");
        assert!(
            read_stored(r#"{"kind":"future","payload":true}"#)
                .unwrap()
                .is_none()
        );
        assert!(read_stored(r#"{"kind":"emoji"}"#).is_err());
        for value in ["", "-1", "+1", "00", "9223372036854775808"] {
            assert!(revision(value).is_err());
        }
    }
}
