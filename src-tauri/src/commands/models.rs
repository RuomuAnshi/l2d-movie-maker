// src-tauri/src/commands/models.rs
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashSet;

use glob::glob;
use serde::Serialize;
use serde_json::Value;
use tauri::Window;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

/// A save dialog grants only its selected file. Allow precisely its atomic-save siblings.
#[tauri::command]
pub fn allow_project_write(window: tauri::Window, path: String, nonce: String) -> Result<String, String> {
    let file = std::path::PathBuf::from(&path);
    if file.extension().and_then(|value| value.to_str()) != Some("l2dproject")
        || nonce.len() != 36 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("工程保存路径无效。".into());
    }
    let scope = window.fs_scope();
    if !scope.is_allowed(&file) { return Err("请先在保存对话框选择工程文件。".into()); }
    let temporary = format!("{path}.{nonce}.tmp");
    scope.allow_file(&temporary).map_err(|error| error.to_string())?;
    scope.allow_file(format!("{path}.bak")).map_err(|error| error.to_string())?;
    Ok(temporary)
}

/// 由原生对话框选择模型资源，并仅授权本次选中的文件或目录供前端导入。
#[tauri::command]
pub async fn pick_model_source(window: Window, directory: bool) -> Result<Option<String>, String> {
    let dialog = window.dialog().file().set_parent(&window);
    let selected = if directory {
        dialog.set_title("选择 Live2D 模型文件夹").blocking_pick_folder()
    } else {
        dialog
            .set_title("导入 Live2D 模型")
            .add_filter("Live2D 模型", &["zip", "json", "jsonl"])
            .blocking_pick_file()
    };
    let Some(selected) = selected else { return Ok(None) };
    let selected_path = selected.into_path().map_err(|e| format!("读取所选路径失败: {e}"))?;
    let path = fs::canonicalize(&selected_path)
        .map_err(|e| format!("读取所选资源失败 '{}': {e}", selected_path.display()))?;

    let scope = window.fs_scope();
    if directory {
        if !path.is_dir() {
            return Err(format!("所选路径不是文件夹: {}", path.display()));
        }
        scope.allow_directory(&path, true).map_err(|e| e.to_string())?;
    } else {
        if !path.is_file() {
            return Err(format!("所选路径不是文件: {}", path.display()));
        }
        match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("zip") => scope.allow_file(&path).map_err(|e| e.to_string())?,
            Some("json" | "jsonl") => {
                let parent = path.parent().ok_or("无法确定模型资源目录")?;
                scope.allow_directory(parent, true).map_err(|e| e.to_string())?;
            }
            _ => return Err("请选择模型文件夹、ZIP 或 JSON/JSONL 模型配置文件".into()),
        }
    }

    if !scope.is_allowed(&path) {
        return Err(format!("所选路径仍未获得读取权限: {}", path.display()));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct ModelEntry {
    /// 相对 root 的展示路径，例如 "tomori/casual-2023/model.json" 或 "xxx/aggregate.jsonl"
    pub label: String,
    /// 绝对路径（前端可用 convertFileSrc 转 URL）
    pub abs_path: String,
    /// "json" | "jsonl"
    pub kind: String,
}

#[tauri::command]
pub fn find_live2d_models(root: String) -> Result<Vec<ModelEntry>, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("路径 '{}' 不是目录", root.display()));
    }

    let files = get_json_and_jsonl(&root)?;
    let model_files = filter_model_like(&files)?;

    let mut out: Vec<ModelEntry> = model_files
        .into_iter()
        .map(|file| {
            let kind = file
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
                .to_lowercase();

            // 相对路径 label
            let label = file
                .strip_prefix(&root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");

            ModelEntry {
                label,
                abs_path: file.to_string_lossy().into_owned(),
                kind,
            }
        })
        .collect();

    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(out)
}

/// 收集 .json / .jsonl（忽略 *.exp.json），递归遍历
/// 规则：如果发现某目录存在 .jsonl，则忽略该目录及其子目录中的所有 .json 文件
fn get_json_and_jsonl(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let pat = format!("{}/**/*", dir.display());

    // 第一遍：记录所有包含 .jsonl 的“根目录”（jsonl 的父目录）
    let mut skip_dirs: HashSet<PathBuf> = HashSet::new();
    for entry in glob(&pat).map_err(|e| format!("glob 失败: {e}"))? {
        let path = entry.map_err(|e| format!("遍历失败: {e}"))?;
        if path.is_dir() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext == "jsonl" {
            if let Some(parent) = path.parent() {
                skip_dirs.insert(parent.to_path_buf());
            }
        }
    }

    // 第二遍：产出文件列表
    let mut out = Vec::new();
    for entry in glob(&pat).map_err(|e| format!("glob 失败: {e}"))? {
        let path = entry.map_err(|e| format!("遍历失败: {e}"))?;
        if path.is_dir() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext != "json" && ext != "jsonl" {
            continue;
        }

        // 忽略 *.exp.json
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.ends_with(".exp.json") {
            continue;
        }

        if ext == "jsonl" {
            // jsonl 一律保留
            out.push(path);
            continue;
        }

        // 到这里是 .json：如该文件位于任一“含 jsonl 的目录”或其子目录，则跳过
        let mut skip = false;
        for root in &skip_dirs {
            if path.starts_with(root) {
                skip = true;
                break;
            }
        }
        if skip {
            continue;
        }

        out.push(path);
    }

    Ok(out)
}

/// 过滤“看起来像 Live2D 模型/聚合”的文件：
/// - .json：
///     - Cubism2：含 "model" 且 "textures"（非空数组）
///     - Cubism3/4：FileReferences.Moc 存在 且 FileReferences.Textures 为非空数组
///     （⚠️ 不强制文件名叫 model.json）
/// - .jsonl：任意一行满足以下任一条件：
///     - 含 "motions" 或 "expressions"（拼好模汇总行）
///     - 含 "path" 为字符串，且以 ".json" 或 ".model3.json" 结尾（子模型行）
///     - 含 "model" 字段（兼容少数工具产出的格式）
///     - 行本身就是一个标准 Live2D json（调用 is_live2d_json 判断）
/// 仅用于生成清单，具体加载逻辑由前端决定。
fn filter_model_like(files: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();

    'each: for file in files {
        // 文件大小限制（10MB），避免读过大文件
        let metadata = fs::metadata(file)
            .map_err(|e| format!("获取文件元数据失败 '{}': {}", file.display(), e))?;
        if metadata.len() > 10 * 1024 * 1024 {
            continue;
        }

        let ext_jsonl = file.extension().map(|e| e == "jsonl").unwrap_or(false);
        let text = fs::read_to_string(file)
            .map_err(|e| format!("读取 '{}' 失败: {}", file.display(), e))?;

        if ext_jsonl {
            // 逐行判定（jsonl 也可能只有一行就是普通 json）
            for line in text.lines() {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(l) {
                    if is_jsonl_line_model_like(&v) || is_live2d_json(&v) {
                        out.push(file.clone());
                        continue 'each;
                    }
                }
            }
            // 没匹配就丢弃
            continue;
        }

        // .json：尝试解析结构
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if is_live2d_json(&v) {
                out.push(file.clone());
            }
        }
    }

    Ok(out)
}

/// 判定 .json 是否为 Live2D 模型（Cubism2/3/4）
fn is_live2d_json(v: &Value) -> bool {
    // 旧格式（Cubism2）
    let old_ok = v.get("model").is_some()
        && v.get("textures")
            .and_then(|t| t.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);

    // Cubism3/4 (.model3.json)
    let fr = v.get("FileReferences");
    let c34_ok = fr
        .and_then(|fr| fr.get("Moc"))
        .is_some()
        && fr.and_then(|fr| fr.get("Textures"))
            .and_then(|t| t.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);

    old_ok || c34_ok
}

/// 判定 .jsonl 的某一行是否“像”聚合/模型声明
fn is_jsonl_line_model_like(v: &Value) -> bool {
    // 1) 汇总行：包含 motions / expressions
    if v.get("motions").is_some() || v.get("expressions").is_some() {
        return true;
    }
    // 2) 子模型声明：包含 path 且看起来指向一个 model.json / .model3.json
    if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
        let p_lower = p.to_lowercase();
        if p_lower.ends_with(".json") || p_lower.ends_with(".model3.json") {
            return true;
        }
    }
    // 3) 兼容：存在 "model" 字段（部分工具可能写成 { "model": "xxx.model3.json" }）
    if v.get("model").is_some() {
        return true;
    }
    false
}
