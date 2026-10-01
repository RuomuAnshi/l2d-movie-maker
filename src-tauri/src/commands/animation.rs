use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

static EXPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationExportResult {
    pub name: String,
    pub model_path: String,
    pub file_path: String,
    pub relative_file: String,
}

#[tauri::command]
pub fn export_animation_to_model(
    app: tauri::AppHandle,
    model_url: String,
    kind: String,
    name: String,
    text: String,
) -> Result<AnimationExportResult, String> {
    let path = super::server::local_model_path(&app, &model_url)?;
    write_animation(&path, &kind, &name, &text)
}

fn write_animation(
    model_path: &Path,
    kind: &str,
    name: &str,
    text: &str,
) -> Result<AnimationExportResult, String> {
    let _guard = EXPORT_LOCK.lock().map_err(|_| "导出锁不可用")?;
    if !["motion", "expression"].contains(&kind) {
        return Err("动画类型无效".into());
    }
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || name == "."
        || name == ".."
    {
        return Err("名称不能包含路径符号或控制字符，最多 100 字。".into());
    }
    if text.len() > 32 * 1024 * 1024 {
        return Err("动画文件超过 32 MiB，请缩短导出范围".into());
    }
    let original = fs::read(model_path).map_err(|e| format!("读取模型配置失败: {}", e))?;
    let mut settings: Value =
        serde_json::from_slice(&original).map_err(|e| format!("模型配置损坏: {}", e))?;
    let modern = settings["FileReferences"]["Moc"].is_string();
    if !modern && !settings["model"].is_string() {
        return Err("所选文件不是 Live2D 模型配置".into());
    }
    if modern || kind == "expression" {
        let data: Value =
            serde_json::from_str(text).map_err(|e| format!("动画 JSON 无效: {}", e))?;
        let valid = if kind == "motion" {
            data["Version"] == 3 && data["Curves"].is_array() && data["Meta"].is_object()
        } else if modern {
            data["Type"] == "Live2D Expression" && data["Parameters"].is_array()
        } else {
            data["params"].is_array()
        };
        if !valid {
            return Err("动画格式与目标模型不匹配".into());
        }
    } else if !text.lines().any(|line| line.starts_with("$fps=")) {
        return Err("Cubism 2 需要 MTN 动作文件".into());
    }
    let parent = model_path.parent().ok_or("模型配置目录无效")?;
    let folder = if kind == "motion" {
        "motions"
    } else {
        "expressions"
    };
    let suffix = match (modern, kind) {
        (true, "motion") => "motion3.json",
        (true, _) => "exp3.json",
        (false, "motion") => "mtn",
        _ => "exp.json",
    };
    let root = if modern {
        &mut settings["FileReferences"]
    } else {
        &mut settings
    };
    let section = if kind == "motion" {
        if modern {
            "Motions"
        } else {
            "motions"
        }
    } else if modern {
        "Expressions"
    } else {
        "expressions"
    };
    if root[section].is_null() {
        root[section] = if kind == "motion" {
            json!({})
        } else {
            json!([])
        };
    }
    if (kind == "motion" && !root[section].is_object())
        || (kind == "expression" && !root[section].is_array())
    {
        return Err("模型的动作或表情列表损坏，请先修复配置".into());
    }
    let target_dir = parent.join(folder);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建动画目录失败: {}", e))?;
    if !target_dir
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(parent.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("动画目录不能指向模型目录之外".into());
    }
    let mut selected_name = name.to_string();
    let mut index = 1;
    loop {
        let exists =
            if kind == "motion" {
                root[section].get(&selected_name).is_some()
            } else {
                root[section].as_array().unwrap().iter().any(|p| {
                    p[if modern { "Name" } else { "name" }].as_str() == Some(&selected_name)
                })
            };
        if !exists
            && !target_dir
                .join(format!("{}.{}", selected_name, suffix))
                .exists()
        {
            break;
        }
        index += 1;
        selected_name = format!("{}_{}", name, index);
    }
    let relative_file = format!("{}/{}.{}", folder, selected_name, suffix);
    let file_path = parent.join(&relative_file);
    let entry = if modern {
        json!({"File": relative_file, "FadeInTime": 0, "FadeOutTime": 0})
    } else {
        json!({"file": relative_file, "fade_in": 0, "fade_out": 0})
    };
    if kind == "motion" {
        root[section][&selected_name] = json!([entry]);
    } else {
        // Expression configuration entries accept only name and file.
        let entry = if modern {
            json!({"File": relative_file, "Name": selected_name})
        } else {
            json!({"file": relative_file, "name": selected_name})
        };
        root[section].as_array_mut().unwrap().push(entry);
    }
    let updated = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    let backup_path = model_path.with_file_name(format!(
        "{}.animation-export.bak",
        model_path.file_name().unwrap().to_string_lossy()
    ));
    if !backup_path.exists() {
        fs::write(&backup_path, &original).map_err(|e| format!("备份模型配置失败: {}", e))?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = parent.join(format!(
        ".animation-settings-{}-{}.tmp",
        std::process::id(),
        stamp
    ));
    let mut created = false;
    let result = (|| -> Result<(), String> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|e| format!("写入动画失败: {}", e))?;
        created = true;
        output
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        let mut config = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        config.write_all(&updated).map_err(|e| e.to_string())?;
        config.sync_all().map_err(|e| e.to_string())?;
        drop(config);
        fs::rename(&temp, model_path).map_err(|e| format!("更新模型配置失败: {}", e))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        if created {
            let _ = fs::remove_file(&file_path);
        }
        return Err(error);
    }
    Ok(AnimationExportResult {
        name: selected_name,
        model_path: model_path.to_string_lossy().into(),
        file_path: file_path.to_string_lossy().into(),
        relative_file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exports_register_without_overwriting_and_preserve_original_config() {
        for modern in [true, false] {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("l2d-animation-{}", stamp));
            fs::create_dir_all(&dir).unwrap();
            let model = dir.join(if modern {
                "actor.model3.json"
            } else {
                "actor.model.json"
            });
            let original = if modern {
                r#"{"Version":3,"FileReferences":{"Moc":"actor.moc3","Textures":["tex.png"]},"Groups":[]}"#
            } else {
                r#"{"model":"actor.moc","textures":["tex.png"],"layout":{"width":2}}"#
            };
            fs::write(&model, original).unwrap();
            let motion = if modern {
                r#"{"Version":3,"Meta":{},"Curves":[]}"#
            } else {
                "$fps=30\nX=0,1"
            };
            let first = write_animation(&model, "motion", "微笑", motion).unwrap();
            let second = write_animation(&model, "motion", "微笑", motion).unwrap();
            assert_eq!(second.name, "微笑_2");
            assert_eq!(fs::read_to_string(&first.file_path).unwrap(), motion);
            let expression = if modern {
                r#"{"Type":"Live2D Expression","Parameters":[]}"#
            } else {
                r#"{"params":[]}"#
            };
            let result = write_animation(&model, "expression", "表情", expression).unwrap();
            let config: Value = serde_json::from_slice(&fs::read(&model).unwrap()).unwrap();
            if modern {
                assert_eq!(config["FileReferences"]["Textures"][0], "tex.png");
                assert_eq!(
                    config["FileReferences"]["Expressions"][0]["File"],
                    result.relative_file
                );
            } else {
                assert_eq!(config["layout"]["width"], 2);
                assert_eq!(config["expressions"][0]["file"], result.relative_file);
            }
            assert!(write_animation(&model, "motion", "../bad", motion).is_err());
            assert!(write_animation(&model, "motion", "bad", "{}").is_err());
            assert_eq!(
                fs::read_to_string(model.with_file_name(format!(
                    "{}.animation-export.bak",
                    model.file_name().unwrap().to_string_lossy()
                )))
                .unwrap(),
                original
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }
}
