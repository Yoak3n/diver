//! 输出尾部摘要：增量监督只用「最后一段输出」，截取规则纯函数可单测。

/// 取 `full` 末尾至多 `max_chars` 字符；为避免半行，起点回退到最近的行首；
/// 全部空白（含换行）压平为单空格，便于注入单行摘要。
pub fn tail(full: &str, max_chars: usize) -> String {
    if full.chars().count() <= max_chars {
        return collapse(full);
    }
    let skipped = full.chars().count() - max_chars;
    let cut = full
        .char_indices()
        .nth(skipped)
        .map(|(i, _)| i)
        .unwrap_or(full.len());
    let slice = &full[cut..];
    // 对齐到完整行：丢弃首个残行（含其换行）。
    let aligned = match slice.find('\n') {
        Some(i) => &slice[i + 1..],
        None => slice,
    };
    collapse(aligned)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_passthrough_and_collapse() {
        assert_eq!(tail("hello world", 100), "hello world");
        assert_eq!(tail("a\n\n  b\tc ", 100), "a b c", "换行与制表一并压平");
    }

    #[test]
    fn long_tail_starts_at_line_boundary() {
        let line = "x".repeat(50);
        let mut full = String::new();
        for i in 0..10 {
            full.push_str(&format!("line-{i}-{line}\n"));
        }
        let out = tail(&full, 120);
        assert!(out.chars().count() <= 120);
        assert!(!out.contains("line-0-"), "截断后不应残留早期行：{out}");
        assert!(out.contains("line-9"), "应保留最后一线：{out}");
        assert!(!out.starts_with(char::is_whitespace), "起点必须是完整行首");
    }

    #[test]
    fn no_newline_long_input_still_bounded() {
        let full = "y".repeat(5000);
        let out = tail(&full, 100);
        assert!(out.chars().count() <= 100);
    }
}
