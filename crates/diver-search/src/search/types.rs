//! 搜索输入/输出/错误类型。

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

pub(super) fn invalid_pattern(message: String) -> SearchError {
    SearchError { code: SearchErrorCode::InvalidPattern, message }
}

pub(super) fn invalid_target(message: String) -> SearchError {
    SearchError { code: SearchErrorCode::InvalidTarget, message }
}

pub(super) fn invalid_params(message: String) -> SearchError {
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

/// 测试辅助：临时目录。
#[cfg(test)]
pub(super) fn tmpdir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("diver-search-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
