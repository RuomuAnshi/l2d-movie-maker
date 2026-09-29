import type { MutableRefObject } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { Live2DModel } from "pixi-live2d-display";
import { exportModelParts } from "../utils/partScreenshot";

interface ScreenshotManagerProps {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  modelRef: MutableRefObject<Live2DModel | Live2DModel[] | null>;
  showAlert: (msg: string) => void;
}

export default function ScreenshotManager({ canvasRef, modelRef, showAlert }: ScreenshotManagerProps) {
  const takeScreenshot = async () => {
    if (!canvasRef.current) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvasRef.current!.toBlob((image) => resolve(image), "image/png", 1);
      });
      if (!blob) {
        showAlert("截图失败");
        return;
      }

      const output = await save({
        defaultPath: `screenshot-${Date.now()}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (output) await writeFile(output, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      showAlert("截图失败");
    }
  };

  const takePartsScreenshots = async () => {
    if (!canvasRef.current || !modelRef.current) {
      showAlert("模型或 Canvas 未初始化");
      return;
    }
    try {
      await exportModelParts(modelRef.current, canvasRef.current);
    } catch (error) {
      showAlert("部件截图失败: " + String(error));
    }
  };

  return { takeScreenshot, takePartsScreenshots };
}
