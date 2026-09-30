use serde::Deserialize;
use std::{path::PathBuf, process::Command};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioManifestItem {
    path: String,
    start_sec: f64,
    duration_sec: f64,
    #[serde(default)]
    source_in_sec: f64,
    #[serde(default = "default_playback_rate")]
    playback_rate: f64,
    gain: f64,
    #[serde(default)]
    fade_in_sec: f64,
    #[serde(default)]
    fade_out_sec: f64,
    #[serde(default)]
    gain_envelopes: Vec<AudioGainEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioGainEnvelope {
    gain: f64,
    keys: Vec<AudioGainKey>,
    fade_in_start: f64,
    fade_in_duration: f64,
    fade_out_start: f64,
    fade_out_duration: f64,
}

#[derive(Debug, Deserialize)]
struct AudioGainKey {
    time: f64,
    value: f64,
}

fn default_playback_rate() -> f64 {
    1.0
}

fn atempo_chain(rate: f64) -> String {
    let mut remaining = rate;
    let mut parts = Vec::new();
    while remaining > 2.0 {
        parts.push("atempo=2.0".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        parts.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 0.0001 {
        parts.push(format!("atempo={remaining:.12}"));
    }
    parts.join(",")
}

fn envelope_expression(envelope: &AudioGainEnvelope) -> String {
    let mut keys: Vec<&AudioGainKey> = envelope.keys.iter().collect();
    keys.sort_by(|a, b| a.time.total_cmp(&b.time));
    // Match sampleVolumeKeys: the last key wins at a duplicated timestamp.
    keys.reverse();
    keys.dedup_by(|a, b| a.time == b.time);
    keys.reverse();
    let mut expression = if let Some(last) = keys.last() {
        format!("{:.12}", last.value.max(0.0))
    } else {
        format!("{:.12}", envelope.gain.max(0.0))
    };
    for pair in keys.windows(2).rev() {
        let (left, right) = (pair[0], pair[1]);
        let ramp = format!(
            "({:.12}+({:.12})*(t-({:.12}))/({:.12}))",
            left.value,
            right.value - left.value,
            left.time,
            right.time - left.time
        );
        expression = format!("if(lt(t,{:.12}),{ramp},{expression})", right.time);
    }
    if let Some(first) = keys.first() {
        expression = format!(
            "if(lt(t,{:.12}),{:.12},{expression})",
            first.time,
            envelope.gain.max(0.0)
        );
    }
    if envelope.fade_in_duration > 0.0 {
        expression = format!(
            "({expression})*clip((t-({:.12}))/{:.12},0,1)",
            envelope.fade_in_start, envelope.fade_in_duration
        );
    }
    if envelope.fade_out_duration > 0.0 {
        expression = format!(
            "({expression})*clip(1-(t-({:.12}))/{:.12},0,1)",
            envelope.fade_out_start, envelope.fade_out_duration
        );
    }
    expression
}

fn valid_envelope(envelope: &AudioGainEnvelope) -> bool {
    [
        envelope.gain,
        envelope.fade_in_start,
        envelope.fade_in_duration,
        envelope.fade_out_start,
        envelope.fade_out_duration,
    ]
    .iter()
    .all(|v| v.is_finite())
        && envelope.fade_in_duration >= 0.0
        && envelope.fade_out_duration >= 0.0
        && envelope.keys.len() <= 100_000
        && envelope
            .keys
            .iter()
            .all(|key| key.time.is_finite() && key.value.is_finite() && key.value >= 0.0)
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
            manifest = serde_json::from_str(&json).map_err(|e| format!("解析音频清单失败: {e}"))?;
        }
    }
    for item in &manifest {
        if !(item.start_sec.is_finite()
            && item.duration_sec.is_finite()
            && item.source_in_sec.is_finite()
            && item.playback_rate.is_finite()
            && item.fade_in_sec.is_finite()
            && item.fade_out_sec.is_finite()
            && item.gain.is_finite()
            && item.duration_sec > 0.0
            && item.playback_rate > 0.0
            && (item.duration_sec * item.playback_rate).is_finite()
            && item.gain_envelopes.iter().all(valid_envelope))
        {
            return Err(format!("音频片段参数无效：{}", item.path));
        }
        if !(item.path.starts_with("http://") || item.path.starts_with("https://"))
            && !PathBuf::from(&item.path).is_file()
        {
            return Err(format!("找不到音频素材，请重新链接：{}", item.path));
        }
    }

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
            let dur = item.duration_sec.max(0.0);
            if dur <= 0.0 {
                continue;
            }
            let gain = item.gain.clamp(0.0, 4.0);
            let tag = format!("a{}", idx);

            let source_duration = dur * item.playback_rate;
            let mut chain = vec![
                format!(
                    "atrim=start={:.6}:duration={:.6}",
                    item.source_in_sec.max(0.0),
                    source_duration
                ),
                "asetpts=PTS-STARTPTS".to_string(),
            ];
            if !item.gain_envelopes.is_empty() && (item.playback_rate - 1.0).abs() > 0.00000001 {
                // V3 preview uses AudioBufferSourceNode.playbackRate. Resampling
                // preserves the same duration and pitch change in the export.
                let source_rate = 48000.0 * item.playback_rate;
                if source_rate < 1.0 || source_rate > i32::MAX as f64 {
                    return Err(format!(
                        "音频嵌套速率超出编码器可用范围：{}",
                        item.playback_rate
                    ));
                }
                chain.push("aresample=48000".to_string());
                chain.push(format!("asetrate={source_rate:.9}"));
                chain.push("aresample=48000".to_string());
            } else {
                let atempo = atempo_chain(item.playback_rate);
                if !atempo.is_empty() {
                    chain.push(atempo);
                }
            }
            if item.gain_envelopes.is_empty() {
                let fade_in = item.fade_in_sec.clamp(0.0, dur);
                let fade_out = item.fade_out_sec.clamp(0.0, dur);
                if fade_in > 0.0 {
                    chain.push(format!("afade=t=in:st=0:d={fade_in:.9}"));
                }
                if fade_out > 0.0 {
                    chain.push(format!(
                        "afade=t=out:st={:.9}:d={fade_out:.9}",
                        (dur - fade_out).max(0.0)
                    ));
                }
                chain.push(format!("volume={gain:.12}"));
            } else {
                let expression = item
                    .gain_envelopes
                    .iter()
                    .map(|envelope| format!("({})", envelope_expression(envelope)))
                    .collect::<Vec<_>>()
                    .join("*");
                chain.push(format!("volume='{expression}':eval=frame"));
            }
            // Apply the schedule offset at sample precision after local-time envelopes.
            chain.push("aresample=48000".to_string());
            chain.push(format!(
                "adelay={}S:all=1",
                (start * 48000.0).round() as u64
            ));
            filters.push(format!("[{}:a]{}[{}]", input_index, chain.join(","), tag));
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
            args.push(
                if format == "webm" {
                    "libopus"
                } else {
                    "pcm_s16le"
                }
                .into(),
            );
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

    let result = Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;

    if !result.status.success() {
        let diagnostic = String::from_utf8_lossy(&result.stderr);
        let tail = diagnostic
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("ffmpeg: 编码 {format} 失败\n{tail}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_rates_are_not_clamped_and_envelopes_keep_crop_phase() {
        assert_eq!(
            atempo_chain(16.0),
            "atempo=2.0,atempo=2.0,atempo=2.0,atempo=2.000000000000"
        );
        assert_eq!(
            atempo_chain(0.125),
            "atempo=0.5,atempo=0.5,atempo=0.500000000000"
        );
        let envelope = AudioGainEnvelope {
            gain: 0.8,
            keys: vec![
                AudioGainKey {
                    time: -1.0,
                    value: 0.2,
                },
                AudioGainKey {
                    time: 1.0,
                    value: 1.0,
                },
            ],
            fade_in_start: -0.5,
            fade_in_duration: 1.0,
            fade_out_start: 2.0,
            fade_out_duration: 1.0,
        };
        let expression = envelope_expression(&envelope);
        assert!(expression.contains("t-(-1.000000000000)"));
        assert!(expression.contains("t-(-0.500000000000)"));
        assert!(valid_envelope(&envelope));
        let duplicate_keys = AudioGainEnvelope {
            gain: 0.8,
            keys: vec![
                AudioGainKey {
                    time: 0.0,
                    value: 0.2,
                },
                AudioGainKey {
                    time: 0.0,
                    value: 0.7,
                },
                AudioGainKey {
                    time: 1.0,
                    value: 1.0,
                },
            ],
            fade_in_start: 0.0,
            fade_in_duration: 0.0,
            fade_out_start: 1.0,
            fade_out_duration: 0.0,
        };
        let expression = envelope_expression(&duplicate_keys);
        assert!(expression.contains("0.700000000000"));
        assert!(!expression.contains("0.200000000000"));
    }

    #[test]
    #[ignore = "requires installed ffmpeg and ffprobe; run explicitly for native export acceptance"]
    fn native_mov_and_webm_keep_alpha_and_mix_nested_audio() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("l2d-native-export-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let frames = dir.join("frame-%06d.png");
        let source = dir.join("tone.wav");
        let prepare = |arguments: Vec<String>| {
            let result = Command::new("ffmpeg").args(arguments).output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        prepare(vec![
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "color=c=red@0.5:s=16x16:r=10,format=rgba".into(),
            "-frames:v".into(),
            "2".into(),
            frames.to_string_lossy().into(),
        ]);
        prepare(vec![
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:duration=1".into(),
            source.to_string_lossy().into(),
        ]);
        let manifest = serde_json::json!([{
            "path": source, "startSec": 0.005, "durationSec": 0.16, "sourceInSec": 0.1, "playbackRate": 2.0, "gain": 1.0,
            "gainEnvelopes": [{ "gain": 0.8, "keys": [{ "time": -0.1, "value": 0.25 }, { "time": 0.1, "value": 0.75 }],
                "fadeInStart": -0.05, "fadeInDuration": 0.1, "fadeOutStart": 0.12, "fadeOutDuration": 0.1 }]
        }]).to_string();
        for format in ["mov", "webm"] {
            let output = dir.join(format!("output.{format}"));
            tauri::async_runtime::block_on(encode_png_sequence_to_video(
                dir.to_string_lossy().into(),
                "frame-%06d.png".into(),
                output.to_string_lossy().into(),
                format.into(),
                10,
                0.2,
                Some(manifest.clone()),
            ))
            .unwrap();
            let probe = Command::new("ffprobe")
                .args(["-v", "error", "-show_streams", "-of", "json"])
                .arg(&output)
                .output()
                .unwrap();
            assert!(probe.status.success());
            let data: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
            let streams = data["streams"].as_array().unwrap();
            let video = streams
                .iter()
                .find(|stream| stream["codec_type"] == "video")
                .unwrap();
            let audio = streams
                .iter()
                .find(|stream| stream["codec_type"] == "audio")
                .unwrap();
            if format == "mov" {
                assert_eq!(video["codec_name"], "prores");
                assert!(video["pix_fmt"].as_str().unwrap().starts_with("yuva"));
                assert_eq!(audio["codec_name"], "pcm_s16le");
            } else {
                assert_eq!(video["codec_name"], "vp9");
                assert_eq!(video["tags"]["alpha_mode"], "1");
                assert_eq!(audio["codec_name"], "opus");
            }
            let mut alpha_decode = Command::new("ffmpeg");
            alpha_decode.args(["-v", "error"]);
            // The FFmpeg native VP9 decoder ignores WebM's auxiliary alpha stream.
            if format == "webm" {
                alpha_decode.args(["-c:v", "libvpx-vp9"]);
            }
            let alpha = alpha_decode
                .args(["-i"])
                .arg(&output)
                .args([
                    "-an",
                    "-vf",
                    "alphaextract",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                    "pipe:1",
                ])
                .output()
                .unwrap();
            assert!(
                alpha.status.success(),
                "{}",
                String::from_utf8_lossy(&alpha.stderr)
            );
            assert!(!alpha.stdout.is_empty());
            let mean_alpha = alpha.stdout.iter().map(|value| *value as f64).sum::<f64>()
                / alpha.stdout.len() as f64;
            assert!(
                (mean_alpha - 128.0).abs() < 5.0,
                "{format} must retain the fixture's 50% alpha, decoded mean={mean_alpha}"
            );
            let decoded = Command::new("ffmpeg")
                .args(["-v", "error", "-i"])
                .arg(&output)
                .args(["-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"])
                .output()
                .unwrap();
            assert!(decoded.status.success());
            let samples = decoded
                .stdout
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            let region = &samples[2880..5760]; // 60–120ms, clear of clip boundaries.
            let crossings = region
                .windows(2)
                .filter(|pair| pair[0].is_sign_positive() != pair[1].is_sign_positive())
                .count();
            let frequency = crossings as f64 * 48000.0 / (2.0 * region.len() as f64);
            assert!(
                (frequency - 880.0).abs() < 30.0,
                "V3 buffer rate semantics: {format} exported {frequency}Hz instead of 880Hz"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
