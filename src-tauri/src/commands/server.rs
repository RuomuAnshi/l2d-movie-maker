// src-tauri/src/commands/server.rs
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response, Server};
use mime_guess;
use urlencoding;


#[derive(Serialize)]
pub struct ModelServerInfo {
    pub base_url: String,
    pub models_dir: String,
}

#[derive(Serialize)]
pub struct ModelEntry {
    pub label: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct ExternalAssetRootInfo {
    pub root_key: String,
    pub root_path: String,
    pub base_url: String,
}

/// 获取可执行文件所在目录
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or(std::env::current_dir().unwrap())
}

/// 启动静态文件服务器
fn start_static_server(model_root: PathBuf) -> u16 {
    // 尝试多个端口，避免端口冲突
    let ports = vec![1430u16, 1431u16, 1432u16, 1433u16, 1434u16];
    
    for &port in &ports {
        match Server::http(format!("127.0.0.1:{}", port)) {
            Ok(server) => {
                // 成功绑定端口，启动服务器
                let exe_dir = exe_dir();
                let figure_root = exe_dir.join("figure");
                
                thread::spawn(move || {
                    for req in server.incoming_requests() {
                        handle_req_with_roots(req, &model_root, &figure_root);
                    }
                });
                return port;
            }
            Err(_) => {
                // 端口被占用，尝试下一个
                continue;
            }
        }
    }
    
    // 所有端口都被占用，使用随机端口
    panic!("无法绑定任何可用端口，请检查网络配置");
}

fn external_roots() -> &'static Mutex<HashMap<String, PathBuf>> {
    static EXTERNAL_ROOTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    EXTERNAL_ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a model URL owned by our server, including registered project resources.
pub fn local_model_path(app: &AppHandle, model_url: &str) -> Result<PathBuf, String> {
    let model_dir = prepare_model_dir(app)?;
    let port = ensure_model_server_started(model_dir.clone())?;
    let prefix = format!("http://127.0.0.1:{}/", port);
    let relative = model_url.strip_prefix(&prefix).ok_or("只能加入当前加载的本地立绘；远程模型请先导入模型库。")?;
    let relative = relative.split(['?', '#']).next().unwrap_or("");
    let (root, encoded) = if let Some(path) = relative.strip_prefix("model/") {
        (model_dir, path.to_string())
    } else if let Some(path) = relative.strip_prefix("external/") {
        let (key, path) = path.split_once('/').ok_or("外部模型地址无效")?;
        let root = external_roots().lock().map_err(|_| "资源注册表不可用")?
            .get(key).cloned().ok_or("模型资源已失效，请重新打开工程")?;
        (root, path.to_string())
    } else { return Err("模型地址无效".into()); };
    let decoded = urlencoding::decode(&encoded).map_err(|_| "模型地址编码无效")?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = canonical_root.join(&*decoded).canonicalize().map_err(|e| format!("无法读取模型配置: {}", e))?;
    if !path.starts_with(&canonical_root) || !path.is_file() { return Err("模型地址超出资源目录".into()); }
    Ok(path)
}

fn hash_root_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().to_lowercase();
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn prepare_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let model_dir = app_data_dir.join("models");
    if !model_dir.exists() {
        fs::create_dir_all(&model_dir)
            .map_err(|e| format!("创建模型库目录失败: {}", e))?;
    }

    // 一次性从旧版 exe_dir/model 迁移已有模型。之后的新模型只进入应用数据目录，
    // 不依赖安装目录是否可写，也不影响旧目录中的源文件。
    let has_content = fs::read_dir(&model_dir)
        .map_err(|e| format!("读取模型库目录失败: {}", e))?
        .filter_map(Result::ok)
        .any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name != "models.json" && name != ".DS_Store" && !name.starts_with("._")
        });
    if !has_content {
        let legacy_dir = exe_dir().join("model");
        if legacy_dir.exists() && legacy_dir != model_dir {
            copy_legacy_model_contents(&legacy_dir, &model_dir)?;
        }
    }
    Ok(model_dir)
}

fn copy_legacy_model_contents(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("读取旧模型目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("遍历旧模型目录失败: {}", e))?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if name_text == "models.json" || name_text == ".DS_Store" || name_text.starts_with("._") {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        let metadata = fs::symlink_metadata(&from)
            .map_err(|e| format!("读取旧模型资源信息失败: {}", e))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            fs::create_dir_all(&to).map_err(|e| format!("创建模型目录失败: {}", e))?;
            copy_legacy_model_contents(&from, &to)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("迁移模型文件失败: {}", e))?;
        }
    }
    Ok(())
}

fn ensure_model_server_started(model_dir: PathBuf) -> Result<u16, String> {
    fs::create_dir_all(&model_dir).map_err(|e| format!("创建模型库目录失败: {}", e))?;

    static PORT: OnceLock<u16> = OnceLock::new();
    let port = *PORT.get_or_init(|| start_static_server(model_dir));
    std::env::set_var("VITE_TAURI_SERVER_PORT", port.to_string());
    Ok(port)
}

fn add_cors_headers<T: Read>(response: &mut Response<T>) {
    response.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
    response.add_header(Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, OPTIONS"[..]).unwrap());
    response.add_header(Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"*"[..]).unwrap());
}

/// 处理 HTTP 请求
fn handle_req(req: Request, model_root: &PathBuf) {
    if req.method() == &Method::Options {
        let mut resp = Response::empty(204);
        add_cors_headers(&mut resp);
        let _ = req.respond(resp);
        return;
    }

    let url = req.url().to_string();
    
    // 支持 /model/... 和 /figure/... 路由
    let (_prefix, rel) = if url.starts_with("/model/") {
        ("/model/", url.strip_prefix("/model/").unwrap_or(""))
    } else if url.starts_with("/figure/") {
        ("/figure/", url.strip_prefix("/figure/").unwrap_or(""))
    } else {
        let mut resp = Response::from_string("Not Found").with_status_code(404);
        add_cors_headers(&mut resp);
        let _ = req.respond(resp);
        return;
    };
    
    // 对相对路径进行URL解码，处理中文字符等非ASCII字符
    let decoded_rel = match urlencoding::decode(&rel) {
        Ok(decoded) => decoded,
        Err(_) => {
            let mut resp = Response::from_string("Invalid URL encoding").with_status_code(400);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
    };
    
    let path = model_root.join(&*decoded_rel);

    // 禁止目录遍历
    if let Ok(canon) = path.canonicalize() {
        if !canon.starts_with(model_root.canonicalize().unwrap()) {
            let mut resp = Response::from_string("Forbidden").with_status_code(403);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
    }

    // 读取文件
    match std::fs::read(&path) {
        Ok(bytes) => {
            // 特殊处理 .jsonl 文件，设置正确的 Content-Type
            let mut resp = Response::from_data(bytes);
            if path.extension().and_then(|ext| ext.to_str()).map(|s| s.eq_ignore_ascii_case("jsonl")).unwrap_or(false) {
                resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            } else {
                let mime = mime_guess::from_path(&path).first_or_octet_stream();
                resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_ref().as_bytes()).unwrap());
            }
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
        }
        Err(_) => {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
        }
    }
}

/// 处理 HTTP 请求（支持多个根目录）
fn handle_req_with_roots(req: Request, model_root: &PathBuf, figure_root: &PathBuf) {
    if req.method() == &Method::Options {
        let mut resp = Response::empty(204);
        add_cors_headers(&mut resp);
        let _ = req.respond(resp);
        return;
    }

    let url = req.url().to_string();
    
    // 支持 /model/... /figure/... /external/<key>/... 路由
    let (root_dir, rel) = if url.starts_with("/model/") {
        (model_root.clone(), url.strip_prefix("/model/").unwrap_or("").to_string())
    } else if url.starts_with("/figure/") {
        (figure_root.clone(), url.strip_prefix("/figure/").unwrap_or("").to_string())
    } else if url.starts_with("/external/") {
        let external_rel = url.strip_prefix("/external/").unwrap_or("");
        let mut segments = external_rel.splitn(2, '/');
        let root_key = segments.next().unwrap_or("");
        let rel = segments.next().unwrap_or("");

        if root_key.is_empty() || rel.is_empty() {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }

        let root_dir = {
            let registry = external_roots().lock().unwrap();
            registry.get(root_key).cloned()
        };

        let Some(root_dir) = root_dir else {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        };

        (root_dir, rel.to_string())
    } else {
        let mut resp = Response::from_string("Not Found").with_status_code(404);
        add_cors_headers(&mut resp);
        let _ = req.respond(resp);
        return;
    };
    
    // 对相对路径进行URL解码，处理中文字符等非ASCII字符
    let decoded_rel = match urlencoding::decode(&rel) {
        Ok(decoded) => decoded,
        Err(_) => {
            let mut resp = Response::from_string("Invalid URL encoding").with_status_code(400);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
    };
    
    let requested_path = root_dir.join(&*decoded_rel);
    let root_canonical = match root_dir.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
    };
    let path = match requested_path.canonicalize() {
        Ok(path) if path.starts_with(&root_canonical) => path,
        Ok(_) => {
            let mut resp = Response::from_string("Forbidden").with_status_code(403);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
        Err(_) => {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
            return;
        }
    };

    // 读取文件
    match std::fs::read(&path) {
        Ok(bytes) => {
            // 特殊处理 .jsonl 文件，设置正确的 Content-Type
            let mut resp = Response::from_data(bytes);
            if path.extension().and_then(|ext| ext.to_str()).map(|s| s.eq_ignore_ascii_case("jsonl")).unwrap_or(false) {
                resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            } else {
                let mime = mime_guess::from_path(&path).first_or_octet_stream();
                resp.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_ref().as_bytes()).unwrap());
            }
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
        }
        Err(_) => {
            let mut resp = Response::from_string("Not Found").with_status_code(404);
            add_cors_headers(&mut resp);
            let _ = req.respond(resp);
        }
    }
}

/// 扫描模型目录并生成 models.json
fn scan_models_dir(models_dir: &PathBuf) -> Result<Vec<ModelEntry>, String> {
    let mut models = Vec::new();
    
    // 递归扫描所有子目录
    scan_directory_recursive(models_dir, models_dir, &mut models, false)?;
    
    // 按名称排序
    models.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(models)
}

/// 递归扫描目录，查找Live2D模型文件和.jsonl文件
fn scan_directory_recursive(
    current_dir: &Path,
    base_dir: &Path,
    models: &mut Vec<ModelEntry>,
    mut skip_json_in_tree: bool,   // 新增：是否在这棵子树内忽略 .json
) -> Result<(), String> {
    // 先看当前目录是否有 jsonl，有则标记
    if !skip_json_in_tree {
        for e in fs::read_dir(current_dir).map_err(|e| format!("读取目录失败: {}", e))? {
            let p = e.map_err(|e| format!("遍历目录失败: {}", e))?.path();
            if p.is_file() && p.extension().and_then(|x| x.to_str()).map(|s| s.eq_ignore_ascii_case("jsonl")).unwrap_or(false) {
                skip_json_in_tree = true;
                break;
            }
        }
    }

    for entry in fs::read_dir(current_dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("遍历目录失败: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            // 子目录继承 skip_json_in_tree
            scan_directory_recursive(&path, base_dir, models, skip_json_in_tree)?;
            continue;
        }

        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

        match ext.as_str() {
            "jsonl" => {
                if is_valid_jsonl_file(&path)? {
                    let relative = path.strip_prefix(base_dir).map_err(|e| format!("路径处理失败: {}", e))?
                        .to_string_lossy().replace('\\', "/");
                    let label = path.file_name().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
                    models.push(ModelEntry { label: format!("{} (JSONL)", label), path: relative });
                }
            }
            "json" => {
                if skip_json_in_tree { continue; } // 关键：该树已发现 jsonl，就忽略 .json

                if is_live2d_model_file(&path)? {
                    let relative = path.strip_prefix(base_dir).map_err(|e| format!("路径处理失败: {}", e))?
                        .to_string_lossy().replace('\\', "/");
                    let label = path.file_name().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
                    models.push(ModelEntry { label: format!("{} ({})", label, relative), path: relative });
                }
            }
            "moc" | "moc3" => {
                if skip_json_in_tree { continue; } // 同理：避免把它匹配到的 config.json 又加回来
                if let Some(cfg) = find_model_config_for_moc(&path)? {
                    let relative = cfg.strip_prefix(base_dir).map_err(|e| format!("路径处理失败: {}", e))?
                        .to_string_lossy().replace('\\', "/");
                    let label = path.file_name().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
                    models.push(ModelEntry { label: format!("{} (MOC)", label), path: relative });
                }
            }
            _ => {}
        }
    }
    Ok(())
}


/// 检查文件是否为Live2D模型文件
fn is_live2d_model_file(file_path: &Path) -> Result<bool, String> {
    // 文件大小限制（10MB）
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("获取文件元数据失败: {}", e))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Ok(false);
    }
    
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    
    // 尝试解析JSON
    let json: Value = serde_json::from_str(&content)
        .map_err(|e| format!("JSON解析失败: {}", e))?;
    
    // Cubism2格式：包含"model"和"textures"字段
    if json.get("model").is_some() && 
       json.get("textures").and_then(|t| t.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
        return Ok(true);
    }
    
    // Cubism3/4格式：包含"FileReferences.Moc"字段
    if let Some(file_refs) = json.get("FileReferences") {
        if file_refs.get("Moc").is_some() {
            return Ok(true);
        }
    }
    
    Ok(false)
}

/// 检查.jsonl文件是否有效
fn is_valid_jsonl_file(file_path: &Path) -> Result<bool, String> {
    // 文件大小限制（5MB）
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("获取文件元数据失败: {}", e))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Ok(false);
    }
    
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    
    let lines: Vec<&str> = content.lines().filter(|line| !line.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok(false);
    }
    
    // 检查是否包含有效的JSON行
    let mut has_valid_line = false;
    for line in lines {
        if let Ok(json) = serde_json::from_str::<Value>(line) {
            // 检查是否包含模型相关字段
            if json.get("path").is_some() || 
               json.get("motions").is_some() || 
               json.get("expressions").is_some() ||
               json.get("model").is_some() {
                has_valid_line = true;
                break;
            }
        }
    }
    
    Ok(has_valid_line)
}

/// 为.moc文件查找对应的配置文件
fn find_model_config_for_moc(moc_path: &Path) -> Result<Option<PathBuf>, String> {
    let parent_dir = moc_path.parent().ok_or("无法获取父目录")?;
    
    // 查找同目录下的配置文件
    for entry in fs::read_dir(parent_dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("遍历目录失败: {}", e))?;
        let path = entry.path();
        
        if path.is_file() {
            if let Some(extension) = path.extension() {
                let ext = extension.to_string_lossy().to_lowercase();
                if ext == "json" && is_live2d_model_file(&path)? {
                    return Ok(Some(path));
                }
            }
        }
    }
    
    Ok(None)
}

/// 生成并保存 models.json
fn generate_models_json(models_dir: &PathBuf) -> Result<(), String> {
    let models = scan_models_dir(models_dir)?;
    let models_json_path = models_dir.join("models.json");
    
    // 转换为前端需要的格式（字符串数组）
    let model_paths: Vec<String> = models.into_iter().map(|m| m.path).collect();
    
    let json_content = serde_json::to_string_pretty(&model_paths)
        .map_err(|e| format!("序列化失败: {}", e))?;
    
    std::fs::write(&models_json_path, json_content)
        .map_err(|e| format!("写入 models.json 失败: {}", e))?;
    
    Ok(())
}

/// 获取模型服务器信息
#[tauri::command]
pub fn get_model_server_info(app: AppHandle) -> Result<ModelServerInfo, String> {
    let model_dir = prepare_model_dir(&app)?;
    let port = ensure_model_server_started(model_dir.clone())?;

    // 启动时重新扫描，避免索引与用户管理的资源库状态不一致。
    generate_models_json(&model_dir)?;

    Ok(ModelServerInfo {
        base_url: format!("http://127.0.0.1:{}/model", port),
        models_dir: model_dir.to_string_lossy().into(),
    })
}

#[tauri::command]
pub fn register_external_asset_root(app: AppHandle, path: String) -> Result<ExternalAssetRootInfo, String> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("外部资源目录不存在: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("外部资源路径不是目录: {}", path));
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析外部资源目录 '{}': {}", path, error))?;

    let base_key = hash_root_key(&canonical_root);
    let root_key = {
        let mut registry = external_roots()
            .lock()
            .map_err(|_| "外部资源注册表已损坏".to_string())?;

        let mut candidate = base_key.clone();
        let mut index = 1usize;

        loop {
            match registry.get(&candidate) {
                Some(existing) if existing != &canonical_root => {
                    candidate = format!("{}-{}", base_key, index);
                    index += 1;
                }
                _ => {
                    registry.insert(candidate.clone(), canonical_root.clone());
                    break candidate;
                }
            }
        }
    };

    let model_dir = prepare_model_dir(&app)?;
    let port = ensure_model_server_started(model_dir)?;

    Ok(ExternalAssetRootInfo {
        root_key: root_key.clone(),
        root_path: canonical_root.to_string_lossy().into_owned(),
        base_url: format!("http://127.0.0.1:{}/external/{}", port, root_key),
    })
}

/// 刷新模型索引
#[tauri::command]
pub fn refresh_model_index(app: AppHandle) -> Result<Vec<String>, String> {
    let model_dir = prepare_model_dir(&app)?;
    let _port = ensure_model_server_started(model_dir.clone())?;
    
    // 生成新的 models.json
    generate_models_json(&model_dir)?;
    
    // 返回模型列表
    let models = scan_models_dir(&model_dir)?;
    Ok(models.into_iter().map(|m| m.path).collect())
} 
