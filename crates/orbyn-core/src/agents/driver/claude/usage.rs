//! Sanitized subscription windows from Claude Code control replies.

use orbyn_contracts::LimitWindow;
use serde_json::{Value, json};

use super::probe_failed;
use crate::error::Result;

fn reported_percent(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.min(100.0))
}

fn usage_window(
    id: String,
    label: String,
    minutes: Option<u64>,
    value: &Value,
) -> Option<LimitWindow> {
    let used_percent = reported_percent(value.get("utilization")?)?;
    let resets_at = value
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(|text| {
            use time::format_description::well_known::Rfc3339;
            time::OffsetDateTime::parse(text, &Rfc3339)
                .ok()?
                .format(&Rfc3339)
                .ok()
        });
    Some(LimitWindow {
        id,
        label,
        used_percent,
        window_minutes: minutes,
        resets_at,
    })
}

fn usage_spend_percent(limits: &Value) -> Option<f64> {
    let ratio = |used: &Value, limit: &Value| {
        let used = used
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)?;
        let limit = limit
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)?;
        reported_percent(&json!(used / limit * 100.0))
    };
    if let Some(spend) = limits.get("spend").filter(|value| value["enabled"] == true) {
        let used = &spend["used"];
        let limit = &spend["limit"];
        if used["currency"]
            .as_str()
            .is_some_and(|currency| !currency.trim().is_empty())
            && used["currency"] == limit["currency"]
            && used["exponent"].as_u64().is_some()
            && used["exponent"] == limit["exponent"]
            && used["amount_minor"].as_u64().is_some()
            && limit["amount_minor"].as_u64().is_some()
            && let Some(percent) = ratio(&used["amount_minor"], &limit["amount_minor"])
        {
            return Some(percent);
        }
    }
    let extra = limits
        .get("extra_usage")
        .filter(|value| value["is_enabled"] == true)?;
    ratio(&extra["used_credits"], &extra["monthly_limit"])
        .or_else(|| reported_percent(&extra["utilization"]))
}

/// Keep only subscription windows. The rest of get_usage can contain account,
/// session and local-history data and must never reach the API's raw report.
pub(super) fn parse_usage_report(response: &Value) -> Result<Option<Value>> {
    match response
        .get("rate_limits_available")
        .and_then(Value::as_bool)
    {
        Some(false) => return Ok(None),
        Some(true) => {}
        None => return Err(probe_failed()),
    }
    let limits = response
        .get("rate_limits")
        .filter(|value| value.is_object())
        .ok_or_else(probe_failed)?;
    let mut windows = Vec::new();
    for (id, label, minutes) in [
        ("five_hour", "Session", 300),
        ("seven_day", "Weekly", 10080),
    ] {
        if let Some(window) = usage_window(id.into(), label.into(), Some(minutes), &limits[id]) {
            windows.push(window);
        }
    }
    if let Some(scoped) = limits.get("model_scoped").and_then(Value::as_array) {
        for entry in scoped {
            let Some(name) = entry
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            if let Some(window) = usage_window(
                format!("model:{name}"),
                format!("Weekly · {name}"),
                Some(10080),
                entry,
            ) {
                windows.push(window);
            }
        }
    }
    if let Some(used_percent) = usage_spend_percent(limits) {
        windows.push(LimitWindow {
            id: "monthly_spend".into(),
            label: "Monthly spend".into(),
            used_percent,
            window_minutes: None,
            resets_at: None,
        });
    }
    if windows.is_empty() {
        return Err(probe_failed());
    }
    let mut report = json!({ "windows": windows });
    if let Some(plan) = response
        .get("subscription_type")
        .and_then(Value::as_str)
        .filter(|plan| !plan.trim().is_empty())
    {
        report["planType"] = json!(plan);
    }
    Ok(Some(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_windows_select_fields_and_keep_missing_values_unknown() {
        let report = parse_usage_report(&json!({
            "rate_limits_available": true, "subscription_type": "pro",
            "account": { "token": "PRIVATE-MARKER" }, "behaviors": ["PRIVATE-MARKER"],
            "rate_limits": {
                "five_hour": { "utilization": 27.5, "resets_at": "2027-01-15T08:00:00Z" },
                "seven_day": { "utilization": null, "resets_at": null },
                "model_scoped": [
                    { "display_name": "Example", "utilization": 112, "resets_at": "bad-date" },
                    { "display_name": "Unknown", "utilization": null },
                ],
                "extra_usage": { "is_enabled": true, "monthly_limit": 200, "used_credits": 75 }
            }
        }))
        .unwrap()
        .unwrap();
        assert_eq!(report["windows"].as_array().unwrap().len(), 3);
        assert_eq!(report["windows"][0]["used_percent"], 27.5);
        assert_eq!(report["windows"][0]["window_minutes"], 300);
        assert_eq!(report["windows"][1]["used_percent"], 100.0);
        assert!(report["windows"][1]["resets_at"].is_null());
        assert_eq!(report["windows"][2]["used_percent"], 37.5);
        assert!(!report.to_string().contains("PRIVATE-MARKER"));
        for response in [
            json!({}),
            json!({ "rate_limits_available": true }),
            json!({ "rate_limits_available": true, "rate_limits": { "five_hour": { "utilization": "20" } } }),
            json!({ "rate_limits_available": true, "rate_limits": { "five_hour": { "utilization": -1 } } }),
        ] {
            assert!(parse_usage_report(&response).is_err(), "{response}");
        }
        assert!(
            parse_usage_report(&json!({ "rate_limits_available": false, "rate_limits": null }))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn spend_ratios_require_matching_currency_and_units() {
        let mut limits = json!({ "spend": { "enabled": true,
            "used": { "amount_minor": 250, "currency": "USD", "exponent": 2 },
            "limit": { "amount_minor": 1000, "currency": "USD", "exponent": 2 } } });
        assert_eq!(usage_spend_percent(&limits), Some(25.0));
        limits["spend"]["limit"]["currency"] = json!("EUR");
        assert_eq!(usage_spend_percent(&limits), None);
        limits["spend"]["limit"]["currency"] = json!("USD");
        limits["spend"]["limit"]["exponent"] = json!(3);
        assert_eq!(usage_spend_percent(&limits), None);
        limits["spend"]["limit"]["exponent"] = json!(2);
        limits["spend"]["limit"]["amount_minor"] = json!(0);
        assert_eq!(usage_spend_percent(&limits), None);
    }
}
