//! search 主路径单测。

use super::*;
use crate::search::types::tmpdir;
use std::path::Path;

fn write_file(dir: &Path, name: &str, content: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path.to_string_lossy().into_owned()
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
