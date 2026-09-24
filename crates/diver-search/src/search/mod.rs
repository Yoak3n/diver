//! 文件内容搜索：ripgrep 引擎库（grep-regex / grep-searcher / ignore）。
//!
//! 语义对齐 DSH 上游 `@deepseek-ai/dsh-tool-fs-search`：
//! - pattern 用 ripgrep 正则语法（`(?i)` / `(?s)` 等内联 flag 支持）；
//! - 目录递归遵循 .gitignore / .ignore（ignore crate，与 rg 同源）；
//! - include 是单个正向 glob（OverrideBuilder），支持 `!` 否定（由调用方校验）；
//! - 每行预览按 UTF-8 边界截断到 max_bytes_per_line；
//! - sink 流式早停：达到 max_matches 即停止，返回 truncated + totalMatches；
//! - 单行无效 UTF-8 给占位符而不是整体失败。

mod preview;
mod types;
#[cfg(test)]
mod tests;

pub use types::{Match, SearchError, SearchErrorCode, SearchInput, SearchOutput};

use std::path::Path;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, sinks};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;

use preview::{display_path, preview_line};
use types::{invalid_params, invalid_pattern, invalid_target};

/// 执行一次 grep 搜索。
///
/// - 正则编译失败 → InvalidPattern；
/// - 目标不存在/不可访问 → InvalidTarget；
/// - include glob 非法 → InvalidParams（OverrideBuilder 构造期错误）；
/// - 目录递归中的个别路径错误（权限等）→ 记录告警并继续（rg 语义：不中止）；
/// - 达到 max_matches 时 sink 返回 Ok(false) 提前停止，truncated=true。
pub fn search(input: &SearchInput) -> Result<SearchOutput, SearchError> {
    if input.pattern.trim().is_empty() {
        return Err(invalid_params("pattern must be a non-empty string".to_string()));
    }
    if input.path.trim().is_empty() {
        return Err(invalid_params("path must be a non-empty string".to_string()));
    }
    if input.max_matches == 0 {
        return Err(invalid_params("max_matches must be a positive integer".to_string()));
    }

    let matcher = RegexMatcherBuilder::new()
        .build(&input.pattern)
        .map_err(|err| invalid_pattern(format!("regex parse error: {err}")))?;

    let target = Path::new(&input.path);
    if !target.exists() {
        return Err(invalid_target(format!(
            "search target not found: {}",
            input.path
        )));
    }

    let mut walker = WalkBuilder::new(target);
    // rg 默认语义：遵循 .gitignore/.ignore、跳过隐藏目录、跳过 .git。
    walker.standard_filters(true);
    walker.hidden(false);
    walker.git_ignore(true);
    walker.git_global(true);
    walker.git_exclude(true);
    walker.ignore(true);

    let mut globs: Vec<String> = Vec::new();
    if let Some(include) = &input.include {
        if !include.trim().is_empty() {
            globs.push(include.clone());
        }
    }
    for include in &input.includes {
        if !include.trim().is_empty() {
            globs.push(include.clone());
        }
    }
    if !globs.is_empty() {
        // OverrideBuilder 的 glob 语义与 rg --glob 一致（含 ! 否定、{a,b} 交替）。
        let mut overrides = OverrideBuilder::new(&input.path);
        for glob in &globs {
            overrides
                .add(glob)
                .map_err(|err| invalid_params(format!("invalid include glob '{glob}': {err}")))?;
        }
        let overrides = overrides
            .build()
            .map_err(|err| invalid_params(format!("invalid include glob: {err}")))?;
        walker.overrides(overrides);
    }

    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .build();

    let mut matches: Vec<Match> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    let mut warnings: Vec<String> = Vec::new();

    for result in walker.build() {
        if truncated {
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(err) => {
                warnings.push(format!("walk error: {err}"));
                continue;
            }
        };
        if !entry.file_type().map_or(false, |t| t.is_file()) {
            continue;
        }
        let entry_path = entry.path();
        let search_path = entry_path;

        let search_result = searcher.search_path(
            &matcher,
            entry_path,
            sinks::UTF8(|line_number: u64, line_text: &str| {
                total += 1;
                if matches.len() >= input.max_matches {
                    truncated = true;
                    return Ok(false);
                }
                let line = preview_line(line_text.trim_end_matches(['\r', '\n']), input.max_bytes_per_line);
                matches.push(Match {
                    path: display_path(&search_path, &input.workdir),
                    line_number,
                    line,
                });
                Ok(true)
            }),
        );
        if let Err(err) = search_result {
            warnings.push(format!("search error on {}: {err}", entry_path.display()));
        }
    }

    if !warnings.is_empty() {
        log::warn!("diver-search: {} warnings", warnings.len());
    }

    Ok(SearchOutput {
        matches,
        truncated,
        total_matches: total,
    })
}
