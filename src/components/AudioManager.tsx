import React from 'react';
import { Live2DModel } from "pixi-live2d-display";

interface Clip {
  id: string;
  name: string;
  start: number;
  duration: number;
  audioUrl?: string;
}

interface AudioManagerProps {
  modelRef: React.MutableRefObject<Live2DModel | Live2DModel[] | null>;
  audioClips: Clip[];
  setCurrentAudioLevel: (level: number) => void;
}

type WebkitAudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

type Live2DInternalModelAccess = {
  parameters?: {
    count: number;
    get: (key: string | number) => { id?: string; value?: number } | undefined;
  };
  coreModel?: {
    setParamFloat?: (id: string, value: number) => void;
  };
};

export type BufferAudioItem = {
  id: string;
  assetId: string;
  sourceTime: number;
  rate: number;
  gain: number;
  active: boolean;
  /** Remaining output time, used to cut nested clips at an exact audio sample. */
  remainingDuration?: number;
};

type BufferPlayback = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  assetId: string;
  startedAt: number;
  sourceTime: number;
  rate: number;
  endSourceTime: number;
};

export default function AudioManager({
  modelRef,
  audioClips,
  setCurrentAudioLevel
}: AudioManagerProps) {
  
  // 音频引用和分析器引用
  const audioRefs = React.useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const audioAnalyzersRef = React.useRef<Map<string, { source: MediaElementAudioSourceNode; analyzer: AnalyserNode; gain: GainNode }>>(new Map());
  const recordingDestinationRef = React.useRef<MediaStreamAudioDestinationNode | null>(null);
  const mouthAnimationRef = React.useRef<{ audioLevel: number; lastUpdate: number }>({ audioLevel: 0, lastUpdate: 0 });
  const decodedAudioRef = React.useRef<Map<string, { url: string; buffer?: AudioBuffer; promise: Promise<AudioBuffer> }>>(new Map());
  const bufferPlaybackRef = React.useRef<Map<string, BufferPlayback>>(new Map());

  const connectAnalyzerOutputs = (gain: GainNode) => {
    const context = audioContextRef.current;
    if (!context) return;
    gain.connect(context.destination);
    if (recordingDestinationRef.current) {
      gain.connect(recordingDestinationRef.current);
    }
  };

  // 初始化音频上下文
  const initAudioContext = () => {
    let createdRecordingDestination = false;
    if (!audioContextRef.current) {
      try {
        const AudioContextCtor = window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext;
        if (!AudioContextCtor) {
          throw new Error("当前环境不支持 AudioContext");
        }
        audioContextRef.current = new AudioContextCtor();
        recordingDestinationRef.current = audioContextRef.current.createMediaStreamDestination();
        createdRecordingDestination = true;
      } catch (error) {
        console.error('�?音频上下文初始化失败:', error);
      }
    }

    if (audioContextRef.current && !recordingDestinationRef.current) {
      recordingDestinationRef.current = audioContextRef.current.createMediaStreamDestination();
      createdRecordingDestination = true;
    }

    if (createdRecordingDestination) {
      audioAnalyzersRef.current.forEach(({ gain }) => {
        try {
          gain.connect(recordingDestinationRef.current!);
        } catch { /* 已连接时忽略 */ }
      });
      bufferPlaybackRef.current.forEach(({ gain }) => gain.connect(recordingDestinationRef.current!));
    }
  };

  const resumeAudioContext = async () => {
    initAudioContext();
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume();
    }
  };

  const registerAudioElement = (clipId: string, audioUrl: string) => {
    initAudioContext();

    const existingAudio = audioRefs.current.get(clipId);
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.src = "";
      audioRefs.current.delete(clipId);
    }

    const existingAnalyzer = audioAnalyzersRef.current.get(clipId);
    if (existingAnalyzer) {
      try {
        existingAnalyzer.source.disconnect();
        existingAnalyzer.analyzer.disconnect();
        existingAnalyzer.gain.disconnect();
      } catch { /* 已断开时忽略 */ }
      audioAnalyzersRef.current.delete(clipId);
    }

    const audioElement = new Audio(audioUrl);
    audioElement.crossOrigin = "anonymous";
    audioElement.preload = "auto";
    audioElement.volume = 1;
    audioRefs.current.set(clipId, audioElement);

    if (audioContextRef.current) {
      try {
        const source = audioContextRef.current.createMediaElementSource(audioElement);
        const analyzer = audioContextRef.current.createAnalyser();
        const gain = audioContextRef.current.createGain();
        analyzer.fftSize = 256;
        analyzer.smoothingTimeConstant = 0.8;
        gain.gain.value = 0.8;

        source.connect(analyzer);
        analyzer.connect(gain);
        connectAnalyzerOutputs(gain);

        audioAnalyzersRef.current.set(clipId, { source, analyzer, gain });
      } catch (error) {
        console.warn("音频分析器初始化失败", error);
      }
    }

    return audioElement;
  };

  const unregisterAudioElement = (clipId: string) => {
    const audio = audioRefs.current.get(clipId);
    if (audio) {
      audio.pause();
      audio.src = '';
      audioRefs.current.delete(clipId);
    }

    const analyzerData = audioAnalyzersRef.current.get(clipId);
    if (analyzerData) {
      try {
        analyzerData.source.disconnect();
        analyzerData.analyzer.disconnect();
        analyzerData.gain.disconnect();
      } catch { /* 已断开时忽略 */ }
      audioAnalyzersRef.current.delete(clipId);
    }
  };

  const setAudioGain = (clipId: string, value: number) => {
    const gain = audioAnalyzersRef.current.get(clipId)?.gain;
    if (!gain) return;
    gain.gain.setValueAtTime(Number.isFinite(value) ? Math.max(0, value) : 0, gain.context.currentTime);
  };

  const prepareAudioBuffer = (assetId: string, url: string): Promise<AudioBuffer> => {
    const cached = decodedAudioRef.current.get(assetId);
    if (cached?.url === url) return cached.promise;
    initAudioContext();
    const context = audioContextRef.current;
    if (!context) return Promise.reject(new Error("当前环境不支持音频解码。"));
    const entry: { url: string; buffer?: AudioBuffer; promise: Promise<AudioBuffer> } = {
      url,
      promise: fetch(url).then(async response => {
        if (!response.ok) throw new Error(`读取音频失败：HTTP ${response.status}`);
        return context.decodeAudioData(await response.arrayBuffer());
      }),
    };
    decodedAudioRef.current.set(assetId, entry);
    entry.promise = entry.promise.then(buffer => {
      if (decodedAudioRef.current.get(assetId) === entry) entry.buffer = buffer;
      return buffer;
    }).catch(error => {
      if (decodedAudioRef.current.get(assetId) === entry) decodedAudioRef.current.delete(assetId);
      throw error;
    });
    return entry.promise;
  };

  const getDecodedAudioBuffer = (assetId: string) => decodedAudioRef.current.get(assetId)?.buffer;

  const stopBufferAudio = (id: string) => {
    const playback = bufferPlaybackRef.current.get(id);
    if (!playback) return;
    bufferPlaybackRef.current.delete(id);
    playback.source.onended = null;
    try { playback.source.stop(); } catch { /* Already ended. */ }
    playback.source.disconnect();
    playback.gain.disconnect();
  };

  const syncBufferAudio = (items: BufferAudioItem[], isPlaying: boolean): void => {
    // The V3 scheduler owns playback. HTML elements remain available for legacy
    // metadata and never play alongside a decoded instance.
    audioRefs.current.forEach(audio => { if (!audio.paused) audio.pause(); });
    if (!isPlaying) {
      for (const id of bufferPlaybackRef.current.keys()) stopBufferAudio(id);
      return;
    }
    initAudioContext();
    const context = audioContextRef.current;
    if (!context) return;
    const retained = new Set<string>();
    for (const item of items) {
      const buffer = decodedAudioRef.current.get(item.assetId)?.buffer;
      if (!item.active || !buffer || !Number.isFinite(item.rate) || item.rate <= 0 || !Number.isFinite(item.sourceTime) || item.sourceTime < 0 || item.sourceTime >= buffer.duration || (item.remainingDuration != null && item.remainingDuration <= 0)) {
        stopBufferAudio(item.id);
        continue;
      }
      retained.add(item.id);
      let playback = bufferPlaybackRef.current.get(item.id);
      const predicted = playback ? playback.sourceTime + (context.currentTime - playback.startedAt) * playback.rate : NaN;
      const endSourceTime = item.remainingDuration != null && Number.isFinite(item.remainingDuration)
        ? Math.min(buffer.duration, item.sourceTime + item.remainingDuration * item.rate) : buffer.duration;
      // Compare in output seconds so fast nested rates do not continually restart.
      const driftLimit = Math.max(0.025, item.rate * 0.04);
      if (playback && (playback.buffer !== buffer || playback.assetId !== item.assetId || playback.rate !== item.rate || Math.abs(predicted - item.sourceTime) > driftLimit || Math.abs(playback.endSourceTime - endSourceTime) > 1 / buffer.sampleRate)) {
        stopBufferAudio(item.id);
        playback = undefined;
      }
      if (!playback) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.setValueAtTime(item.rate, context.currentTime);
        gain.gain.setValueAtTime(Number.isFinite(item.gain) ? Math.max(0, item.gain) : 0, context.currentTime);
        source.connect(gain);
        connectAnalyzerOutputs(gain);
        playback = { source, gain, buffer, assetId: item.assetId, startedAt: context.currentTime, sourceTime: item.sourceTime, rate: item.rate, endSourceTime };
        bufferPlaybackRef.current.set(item.id, playback);
        const instance = playback;
        source.onended = () => {
          if (bufferPlaybackRef.current.get(item.id) === instance) bufferPlaybackRef.current.delete(item.id);
          source.disconnect(); gain.disconnect();
        };
        if (item.remainingDuration != null && Number.isFinite(item.remainingDuration)) {
          source.start(context.currentTime, item.sourceTime, Math.min(buffer.duration - item.sourceTime, item.remainingDuration * item.rate));
        } else source.start(context.currentTime, item.sourceTime);
      } else {
        playback.gain.gain.setValueAtTime(Number.isFinite(item.gain) ? Math.max(0, item.gain) : 0, context.currentTime);
      }
    }
    for (const id of bufferPlaybackRef.current.keys()) if (!retained.has(id)) stopBufferAudio(id);
  };

  // 应用嘴部动画
  const applyMouthAnimation = (audioLevel: number) => {
    if (!modelRef.current) {
      return;
    }
    
    if (audioLevel < 5) {
      return;
    }
    
    
    try {
      forEachModel((model) => {
        // 获取模型的内部模型
        const internalModel = (model as unknown as { internalModel?: Live2DInternalModelAccess }).internalModel;
        if (!internalModel) {
          return;
        }
        
        // 尝试不同的参数访问方�?
        let paramFound = false;
        
        // 方式1: 通过 parameters.get()
        const parameters = internalModel.parameters;
        if (parameters) {
          const mouthParams = [
            'ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthOpen',
            'ParamMouthA', 'ParamMouthI', 'ParamMouthU', 'ParamMouthE', 'ParamMouthO',
            'PARAM_MOUTH_OPEN_Y', 'PARAM_MOUTH_FORM', 'PARAM_MOUTH_OPEN',
            'PARAM_MOUTH_A', 'PARAM_MOUTH_I', 'PARAM_MOUTH_U', 'PARAM_MOUTH_E', 'PARAM_MOUTH_O'
          ];
          
          mouthParams.forEach(paramName => {
            try {
              const param = parameters.get(paramName);
              if (param && typeof param.value !== 'undefined') {
                const mouthValue = Math.min(1.0, Math.max(0.0, audioLevel / 100));
                param.value = mouthValue;
                paramFound = true;
              }
            } catch {
              // 忽略错误，继续尝试下一个参数
            }
          });
        }
        
        // 方式2: 通过 coreModel.setParamFloat()
        const coreModel = internalModel.coreModel;
        if (coreModel && !paramFound) {
          const mouthParams = [
            'PARAM_MOUTH_OPEN_Y', 'PARAM_MOUTH_FORM', 'PARAM_MOUTH_OPEN',
            'PARAM_MOUTH_A', 'PARAM_MOUTH_I', 'PARAM_MOUTH_U', 'PARAM_MOUTH_E', 'PARAM_MOUTH_O'
          ];
          
          mouthParams.forEach(paramName => {
            try {
              const mouthValue = Math.min(1.0, Math.max(0.0, audioLevel / 100));
              coreModel.setParamFloat?.(paramName, mouthValue);
              paramFound = true;
            } catch {
              // 忽略错误，继续尝试下一个参数
            }
          });
        }
        
        // 方式3: 直接访问参数对象
        if (!paramFound && parameters) {
          try {
            // 遍历所有参数，查找包含 mouth 的参数
            for (let i = 0; i < parameters.count; i++) {
              const param = parameters.get(i);
              if (param && param.id && param.id.toLowerCase().includes('mouth')) {
                const mouthValue = Math.min(1.0, Math.max(0.0, audioLevel / 100));
                param.value = mouthValue;
                paramFound = true;
              }
            }
          } catch (error) {
            console.warn('通过索引访问参数失败:', error);
          }
        }
      });
    } catch (error) {
      console.error('�?嘴部动画应用失败:', error);
    }
  };

  // 重置嘴部动画
  const resetMouthAnimation = () => {
    try {
      forEachModel((model) => {
        const internalModel = (model as unknown as { internalModel?: Live2DInternalModelAccess }).internalModel;
        if (!internalModel) return;
        
        // 重置所有嘴部参�?
        const mouthParams = [
          'ParamMouthOpenY', 'ParamMouthForm', 'ParamMouthOpen',
          'ParamMouthA', 'ParamMouthI', 'ParamMouthU', 'ParamMouthE', 'ParamMouthO'
        ];
        
        mouthParams.forEach(paramName => {
          const param = internalModel.parameters?.get(paramName);
          if (param) {
            param.value = 0;
          }
        });
      });
      
      mouthAnimationRef.current.audioLevel = 0;
      mouthAnimationRef.current.lastUpdate = Date.now();
    } catch (error) {
      console.warn('重置嘴部动画失败:', error);
    }
  };

  // 遍历模型的工具函�?
  const forEachModel = (fn: (m: Live2DModel) => void) => {
    const cur = modelRef.current;
    if (!cur) return;
    if (Array.isArray(cur)) cur.forEach(fn);
    else fn(cur as Live2DModel);
  };

  // 清理音频引用
  const cleanupAudio = () => {
    for (const id of bufferPlaybackRef.current.keys()) stopBufferAudio(id);
    decodedAudioRef.current.clear();
    audioRefs.current.forEach(audio => {
      audio.pause();
      audio.src = '';
    });
    audioRefs.current.clear();
    
    audioAnalyzersRef.current.forEach(({ source, analyzer, gain }) => {
      try {
        source.disconnect();
        analyzer.disconnect();
        gain.disconnect();
      } catch { /* 已断开时忽略 */ }
    });
    audioAnalyzersRef.current.clear();
    
    resetMouthAnimation();
  };

  // 停止所有音频播�?
  const stopAllAudio = () => {
    for (const id of bufferPlaybackRef.current.keys()) stopBufferAudio(id);
    audioRefs.current.forEach(audio => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
    resetMouthAnimation();
  };

  // 音频分析和嘴部动画处�?
  const processAudioAnimation = (t: number) => {
    let audioLevel = 0;
    
    audioClips.forEach(clip => {
      const audioElement = audioRefs.current.get(clip.id);
      const analyzerData = audioAnalyzersRef.current.get(clip.id);
      
      if (!audioElement || !analyzerData) {
        return;
      }
      
      if (t >= clip.start && t < clip.start + clip.duration) {
        // 分析当前播放音频的电平
        try {
          const { analyzer } = analyzerData;
          const bufferLength = analyzer.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          
          analyzer.getByteFrequencyData(dataArray);
          
          // 计算平均音量，重点关注人声频率范�?(85Hz - 255Hz)
          let sum = 0;
          let count = 0;
          for (let i = 0; i < bufferLength; i++) {
            // 人声主要频率范围
            if (i >= 3 && i <= 8) { // 大约对应85Hz-255Hz
              sum += dataArray[i];
              count++;
            }
          }
          
          if (count > 0) {
            const average = sum / count;
            const level = Math.min(100, Math.max(0, (average / 255) * 100));
            audioLevel = Math.max(audioLevel, level);
          }
        } catch (error) {
          console.error('音频分析失败:', error);
        }
      }
    });
    
    // 更新状态中的音频电平
    setCurrentAudioLevel(audioLevel);
    
    // 应用嘴部动画
    if (audioLevel > 5) {
      applyMouthAnimation(audioLevel);
      mouthAnimationRef.current.audioLevel = audioLevel;
      mouthAnimationRef.current.lastUpdate = Date.now();
    } else {
      // 如果没有音频，逐渐关闭嘴部
      const timeSinceLastAudio = Date.now() - mouthAnimationRef.current.lastUpdate;
      if (timeSinceLastAudio > 100) { // 100ms后开始关�?
        const decayFactor = Math.max(0, 1 - (timeSinceLastAudio - 100) / 500); // 500ms内完全关�?
        const decayedLevel = mouthAnimationRef.current.audioLevel * decayFactor;
        applyMouthAnimation(decayedLevel);
        mouthAnimationRef.current.audioLevel = decayedLevel;
      }
    }
  };

  return {
    audioRefs,
    audioContextRef,
    audioAnalyzersRef,
    recordingDestinationRef,
    mouthAnimationRef,
    initAudioContext,
    resumeAudioContext,
    registerAudioElement,
    unregisterAudioElement,
    setAudioGain,
    prepareAudioBuffer,
    getDecodedAudioBuffer,
    syncBufferAudio,
    applyMouthAnimation,
    resetMouthAnimation,
    cleanupAudio,
    stopAllAudio,
    processAudioAnimation
  };
} 
