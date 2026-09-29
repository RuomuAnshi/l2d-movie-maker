use serde::Deserialize;
use std::{path::PathBuf, process::Command};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioManifestItem {
    path: String,
    start_sec: f64,
    end_sec: f64,
    gain: f64,
}

/// PNG 序列 -> WebM(VP9 + alpha) 或 MOV(ProRes 4444 + alpha), 可选混音音轨
#[tauri::command]
pub async fn encode_png_sequence_to_video(
    frame_dir: String,
    pattern: String,
    output_path: String,
    format: String,
    fps: u32,
    target_duration_sec: f64,
    audio_manifest_json: Option<String>,
) -> Result<(), String> {
    let format = format.to_ascii_lowercase();
    if format != "webm" && format != "mov" {
        return Err(format!("不支持的视频格式: {format}"));
    }
    let fps = if fps == 0 { 1 } else { fps };
    let target_duration_sec = if target_duration_sec.is_finite() {
        target_duration_sec.max(0.0)
    } else {
        0.0
    };
    let frame_path = PathBuf::from(&frame_dir).join(&pattern);

    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());
    args.push("-framerate".into());
    args.push(fps.to_string());
    args.push("-start_number".into());
    args.push("1".into());
    args.push("-i".into());
    args.push(frame_path.to_string_lossy().to_string());

    let mut manifest: Vec<AudioManifestItem> = Vec::new();
    if let Some(json) = audio_manifest_json {
        if !json.trim().is_empty() {
            manifest = serde_json::from_str(&json)
                .map_err(|e| format!("解析音频清单失败: {e}"))?;
        }
    }
    manifest.retain(|item| {
        item.start_sec.is_finite() && item.end_sec.is_finite() && item.gain.is_finite()
            && item.end_sec.max(item.start_sec.max(0.0)) > item.start_sec.max(0.0)
    });

    for item in &manifest {
        args.push("-i".into());
        args.push(item.path.clone());
    }

    if !manifest.is_empty() {
        let mut filters: Vec<String> = Vec::new();
        let mut mix_inputs: Vec<String> = Vec::new();

        for (idx, item) in manifest.iter().enumerate() {
            let input_index = idx + 1; // 0 是视频输入
            let start = item.start_sec.max(0.0);
            let end = item.end_sec.max(start);
            let dur = (end - start).max(0.0);
            if dur <= 0.0 {
                continue;
            }
            let delay_ms = (start * 1000.0).round() as i64;
            let gain = item.gain.clamp(0.0, 4.0);
            let tag = format!("a{}", idx);

            // [i:a]atrim=0:dur,asetpts,adelay=ms|ms,volume=gain[aN]
            filters.push(format!(
                "[{}:a]atrim=start=0:duration={:.6},asetpts=PTS-STARTPTS,adelay={}:{},volume={:.3}[{}]",
                input_index,
                dur,
                delay_ms,
                delay_ms,
                gain,
                tag
            ));
            mix_inputs.push(format!("[{}]", tag));
        }

        let mix_count = mix_inputs.len();
        if mix_count > 0 {
            filters.push(format!(
                "{}amix=inputs={}:normalize=0[aout]",
                mix_inputs.join(""),
                mix_count
            ));

            args.push("-filter_complex".into());
            args.push(filters.join(";"));
            args.push("-map".into());
            args.push("0:v".into());
            args.push("-map".into());
            args.push("[aout]".into());
            args.push("-c:a".into());
            args.push(if format == "webm" { "libopus" } else { "pcm_s16le" }.into());
            if format == "webm" {
                args.push("-b:a".into());
                args.push("192k".into());
            }
        }
    }

    if format == "webm" {
        args.push("-vf".into());
        args.push("pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black@0".into());
        args.push("-c:v".into());
        args.push("libvpx-vp9".into());
        args.push("-pix_fmt".into());
        args.push("yuva420p".into());
        args.push("-b:v".into());
        args.push("0".into());
        args.push("-crf".into());
        args.push("20".into());
        args.push("-row-mt".into());
        args.push("1".into());
    } else {
        args.push("-c:v".into());
        args.push("prores_ks".into());
        args.push("-profile:v".into());
        args.push("4444".into());
        args.push("-pix_fmt".into());
        args.push("yuva444p10le".into());
        args.push("-alpha_bits".into());
        args.push("16".into());
    }
    if manifest.is_empty() {
        args.push("-an".into());
    }
    if target_duration_sec > 0.0 {
        args.push("-t".into());
        args.push(format!("{:.6}", target_duration_sec));
    }
    args.push("-f".into());
    args.push(format.clone());
    args.push(output_path);

    let st = Command::new("ffmpeg")
        .args(args)
        .status()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;

    if !st.success() {
        return Err(format!("ffmpeg: 编码 {format} 失败"));
    }
    Ok(())
}
