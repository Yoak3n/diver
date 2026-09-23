//! pnpm / npm 包路径与 profile manifest 辅助。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(super) fn pnpm_bin() -> String {
    std::env::var("DIVER_PNPM").unwrap_or_else(|_| "pnpm".into())
}

pub(super) fn run_pnpm(profile_dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(pnpm_bin())
        .args(args)
        .current_dir(profile_dir)
        .stdin(Stdio::null())
        .env("CI", "1")
        .env("npm_config_yes", "true")
        .output()
        .map_err(|e| format!("无法执行 pnpm（{}）: {e}（可设置 DIVER_PNPM 指向 pnpm）", pnpm_bin()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let log = format!("{stdout}\n{stderr}");
    if !out.status.success() {
        return Err(format!("pnpm {} 失败:\n{}", args.join(" "), log.trim()));
    }
    Ok(log)
}

/// Derive npm package name from install spec (file: / scoped / name@version).
pub(super) fn package_name_from_spec(spec: &str, profile_dir: &Path) -> Result<String, String> {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix("file:") {
        let raw = rest.trim_start_matches("./");
        let path = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            profile_dir.join(raw)
        };
        let manifest = path.join("package.json");
        let content =
            fs::read_to_string(&manifest).map_err(|e| format!("读取 file: 包失败 {manifest:?}: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("file: package.json 解析失败: {e}"))?;
        let name = json
            .get("name")
            .and_then(|n| n.as_str())
            .ok_or_else(|| "file: 包缺少 name 字段".to_string())?;
        return Ok(name.to_string());
    }
    if spec.starts_with('@') {
        // @scope/name or @scope/name@version
        let without_ver = match spec.rfind('@') {
            Some(i) if i > 0 => &spec[..i],
            _ => spec,
        };
        return Ok(without_ver.to_string());
    }
    let name = spec.split('@').next().unwrap_or(spec);
    if name.is_empty() {
        return Err(format!("无法从 spec 解析包名: {spec}"));
    }
    Ok(name.to_string())
}

pub(super) fn insert_id_from_package(package_name: &str) -> String {
    let slash = package_name.rfind('/').map(|i| i + 1).unwrap_or(0);
    package_name[slash..].to_string()
}

pub(super) fn node_modules_pkg_dir(profile_dir: &Path, package_name: &str) -> PathBuf {
    if package_name.starts_with('@') {
        let slash = package_name.find('/').unwrap_or(0);
        profile_dir
            .join("node_modules")
            .join(&package_name[..slash])
            .join(&package_name[slash + 1..])
    } else {
        profile_dir.join("node_modules").join(package_name)
    }
}

pub(super) fn package_declares_bundle(profile_dir: &Path, package_name: &str) -> bool {
    let manifest = node_modules_pkg_dir(profile_dir, package_name).join("package.json");
    let Ok(content) = fs::read_to_string(&manifest) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    json.pointer("/dsh/bundle").is_some() || json.pointer("/cos/bundle").is_some()
}

pub(super) fn profile_manifest_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("package.json")
}

pub(super) fn backup_pair(profile_dir: &Path) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    (
        fs::read(profile_manifest_path(profile_dir)).ok(),
        fs::read(profile_dir.join("pnpm-lock.yaml")).ok(),
    )
}

pub(super) fn restore_pair(profile_dir: &Path, pkg: Option<Vec<u8>>, lock: Option<Vec<u8>>) {
    if let Some(bytes) = pkg {
        let _ = fs::write(profile_manifest_path(profile_dir), bytes);
    }
    if let Some(bytes) = lock {
        let _ = fs::write(profile_dir.join("pnpm-lock.yaml"), bytes);
    }
}

pub(super) fn update_profile_bundles(
    profile_dir: &Path,
    package_name: &str,
    add: bool,
) -> Result<(), String> {
    let path = profile_manifest_path(profile_dir);
    let content =
        fs::read_to_string(&path).map_err(|e| format!("读取 profile package.json 失败: {e}"))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("profile package.json 解析失败: {e}"))?;
    if json.get("dsh").and_then(|d| d.get("profile")).is_none() {
        let obj = json.as_object_mut().ok_or("profile package.json 非对象")?;
        obj.insert(
            "dsh".into(),
            serde_json::json!({ "profile": { "bundles": [] } }),
        );
    }
    let bundles = json
        .pointer_mut("/dsh/profile/bundles")
        .ok_or("dsh.profile.bundles 缺失")?;
    let arr = bundles
        .as_array_mut()
        .ok_or("dsh.profile.bundles 不是数组")?;
    let has = arr.iter().any(|v| v.as_str() == Some(package_name));
    if add && !has {
        arr.push(serde_json::Value::String(package_name.to_string()));
    } else if !add && has {
        arr.retain(|v| v.as_str() != Some(package_name));
    } else {
        return Ok(());
    }
    let out = serde_json::to_string_pretty(&json).map_err(|e| format!("manifest 序列化失败: {e}"))?;
    fs::write(&path, out + "\n").map_err(|e| format!("写 profile package.json 失败: {e}"))
}
