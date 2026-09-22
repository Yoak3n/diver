//! 文件内容搜索：ripgrep 引擎库（grep-regex / grep-searcher / ignore）。
//!
//! 语义对齐 DSH 上游 `@deepseek-ai/dsh-tool-fs-search`：
//! - pattern 用 ripgrep 正则语法（`(?i)` / `(?s)` 等内联 flag 支持）；
//! - 目录递归遵循 .gitignore / .ignore（ignore crate，与 rg 同源）；
//! - include 是单个正向 glob（OverrideBuilder），支持 `!` 否定（由调用方校验）；
//! - 每行预览按 UTF-8 边界截断到 max_bytes_per_line；
//! - sink 流式早停：达到 max_matches 即停止，返回 truncated + totalMatches；
//! - 单行无效 UTF-8 给占位符而不是整体失败。

use std::path::Path;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, sinks};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;

/// 稳定错误码（对齐 DSH 的 SEARCH_* 词汇，Node 侧可分支）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchErrorCode {
    /// 正则编译失败（ripgrep 语法错误）。
    InvalidPattern,
    /// 目标路径不存在 / 不可访问 / 非文件非目录。
    InvalidTarget,
    /// 参数错误（调用方校验后仍到达的防御分支）。
    InvalidParams,
    /// 搜索内部错误（IO 等）。
    SearchFailed,
}

impl SearchErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidPattern => "INVALID_PATTERN",
            Self::InvalidTarget => "INVALID_TARGET",
            Self::InvalidParams => "INVALID_PARAMS",
            Self::SearchFailed => "SEARCH_FAILED",
        }
    }
}

/// 搜索错误：code + 模型可见 message。
#[derive(Debug)]
pub struct SearchError {
    pub code: SearchErrorCode,
    pub message: String,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SearchError {}

fn invalid_pattern(message: String) -> SearchError {
    SearchError { code: SearchErrorCode::InvalidPattern, message }
}

fn invalid_target(message: String) -> SearchError {
    SearchError { code: SearchErrorCode::InvalidTarget, message }
}

fn invalid_params(message: String) -> SearchError {
    SearchError { code: SearchErrorCode::InvalidParams, message }
}

/// 一条匹配：文件路径（相对 workdir 展示）、1-based 行号、行文本（可能已预览截断）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Match {
    pub path: String,
    #[serde(rename = "lineNumber")]
    pub line_number: u64,
    pub line: String,
}

/// 搜索结果：匹配列表 + 是否截断 + 总数（截断时计数到上限为止）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchOutput {
    pub matches: Vec<Match>,
    pub truncated: bool,
    pub total_matches: usize,
}

/// 搜索输入。
#[derive(Debug, Clone)]
pub struct SearchInput {
    /// ripgrep 正则。
    pub pattern: String,
    /// 目标文件或目录（绝对路径；调用方负责相对化）。
    pub path: String,
    /// 单个正向 glob 过滤（如 "*.ts"）；None = 不过滤。兼容旧接口。
    pub include: Option<String>,
    /// 多 glob 过滤（rg --glob 语义，支持 `!` 否定、`{a,b}` 交替）。
    /// 与 `include` 合并后一起进 OverrideBuilder。
    pub includes: Vec<String>,
    /// 保留的最大匹配数（对齐 DSH GREP_MAX_MATCHES=250）。
    pub max_matches: usize,
    /// 单行预览最大字节数（对齐 DSH GREP_MAX_LINE_BYTES=2000）。
    pub max_bytes_per_line: usize,
    /// 工作目录：用于把绝对路径转成展示用相对路径。
    pub workdir: String,
}

impl Default for SearchInput {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: String::new(),
            include: None,
            includes: Vec::new(),
            max_matches: 250,
            max_bytes_per_line: 2000,
            workdir: String::new(),
        }
    }
}

/// 把绝对路径相对 workdir 展示；不在 workdir 下则原样。
fn display_path(path: &Path, workdir: &str) -> String {
    if !path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    let workdir_path = Path::new(workdir);
    if let Ok(rel) = path.strip_prefix(workdir_path) {
        if rel.as_os_str().is_empty() {
            return ".".to_string();
        }
        return rel.to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
}

/// 按 UTF-8 边界把一行预览截断到 max_bytes 字节；超长加后缀。
fn preview_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let mut end = 0;
    let mut bytes = 0;
    for (idx, ch) in line.char_indices() {
        let ch_len = ch.len_utf8();
        if bytes + ch_len > max_bytes {
            break;
        }
        bytes += ch_len;
        end = idx + ch_len;
    }
    let mut result = line[..end].to_string();
    result.push_str("... (line truncated)");
    result
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write_file(dir: &Path, name: &str, content: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-search-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_matches_grouped_by_line() {
        let dir = tmpdir("basic");
        write_file(&dir, "a.ts", "line one\nneedle here\nline three\n");
        let input = SearchInput {
            pattern: "needle".to_string(),
            path: dir.to_string_lossy().into_owned(),
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert_eq!(out.matches.len(), 1);
        assert_eq!(out.matches[0].line_number, 2);
        assert_eq!(out.matches[0].line, "needle here");
        assert_eq!(out.matches[0].path, "a.ts");
        assert!(!out.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_matches_is_empty_success() {
        let dir = tmpdir("none");
        write_file(&dir, "a.txt", "nothing here\n");
        let input = SearchInput {
            pattern: "zzz".to_string(),
            path: dir.to_string_lossy().into_owned(),
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert!(out.matches.is_empty());
        assert_eq!(out.total_matches, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_pattern_errors() {
        let input = SearchInput {
            pattern: "(".to_string(),
            path: ".".to_string(),
            ..Default::default()
        };
        let err = search(&input).unwrap_err();
        assert_eq!(err.code, SearchErrorCode::InvalidPattern);
    }

    #[test]
    fn missing_target_errors() {
        let input = SearchInput {
            pattern: "x".to_string(),
            path: "C:/definitely/not/here".to_string(),
            ..Default::default()
        };
        let err = search(&input).unwrap_err();
        assert_eq!(err.code, SearchErrorCode::InvalidTarget);
    }

    #[test]
    fn include_filter_limits_files() {
        let dir = tmpdir("include");
        write_file(&dir, "keep.ts", "needle\n");
        write_file(&dir, "skip.js", "needle\n");
        let input = SearchInput {
            pattern: "needle".to_string(),
            path: dir.to_string_lossy().into_owned(),
            include: Some("*.ts".to_string()),
            includes: Vec::new(),
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert_eq!(out.matches.len(), 1);
        assert_eq!(out.matches[0].path, "keep.ts");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn max_matches_truncates() {
        let dir = tmpdir("cap");
        write_file(&dir, "a.txt", "hit\nhit\nhit\nhit\nhit\n");
        let input = SearchInput {
            pattern: "hit".to_string(),
            path: dir.to_string_lossy().into_owned(),
            max_matches: 2,
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert_eq!(out.matches.len(), 2);
        assert!(out.truncated);
        assert!(out.total_matches >= 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn preview_truncates_long_lines_utf8_safe() {
        let dir = tmpdir("preview");
        let long = "啊".repeat(5000);
        write_file(&dir, "a.txt", &long);
        let input = SearchInput {
            pattern: "啊".to_string(),
            path: dir.to_string_lossy().into_owned(),
            max_bytes_per_line: 2000,
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert_eq!(out.matches.len(), 1);
        assert!(out.matches[0].line.ends_with("... (line truncated)"));
        // 截断后仍必须是合法 UTF-8。
        assert!(std::str::from_utf8(out.matches[0].line.as_bytes()).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn single_file_target_works() {
        let dir = tmpdir("file");
        let file = write_file(&dir, "a.txt", "alpha\nbeta\nalpha\n");
        let input = SearchInput {
            pattern: "alpha".to_string(),
            path: file,
            workdir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let out = search(&input).unwrap();
        assert_eq!(out.matches.len(), 2);
        assert_eq!(out.matches[0].path, "a.txt");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
