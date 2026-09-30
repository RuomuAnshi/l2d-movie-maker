/* eslint-disable @typescript-eslint/no-explicit-any */
export class Vector { x = 1; y = 1; set(x: number, y = x) { this.x = x; this.y = y; } }
export class Rectangle {
  constructor(public x = -50, public y = -50, public width = 100, public height = 100) {}
  contains(x: number, y: number) { return x >= this.x && y >= this.y && x <= this.x + this.width && y <= this.y + this.height; }
}
export class Container {
  children: Container[] = []; parent: Container | null = null;
  position = new Vector(); scale = new Vector(); rotation = 0; alpha = 1; zIndex = 0; sortableChildren = false;
  visible = true; destroyed = false; destroyCalls = 0;
  width = 400; height = 800;
  get x() { return this.position.x; } get y() { return this.position.y; }
  addChild<T extends Container>(child: T) { child.parent?.removeChild(child); this.children.push(child); child.parent = this; return child; }
  removeChild(child: Container) { this.children = this.children.filter((item) => item !== child); child.parent = null; return child; }
  setChildIndex(child: Container, index: number) { this.children = this.children.filter((item) => item !== child); this.children.splice(index, 0, child); }
  getLocalBounds() { return new Rectangle(); }
  destroy(options?: { children?: boolean; texture?: boolean; baseTexture?: boolean }) { this.destroyCalls++; if (this.destroyed) return; this.destroyed = true; this.parent?.removeChild(this); if (options?.children) for (const child of this.children.slice()) child.destroy(options); this.children = []; }
}
export class BaseTexture {
  destroyed = false; destroyCount = 0;
  destroy() { if (!this.destroyed) { this.destroyed = true; this.destroyCount++; } }
}
const textureCache = new Map<string, Texture>();
let imageLoader: ((url: string) => Promise<Texture>) | null = null;
export class Texture {
  static EMPTY = new Texture("empty");
  baseTexture: BaseTexture | null = new BaseTexture();
  destroyed = false; destroyCalls = 0; width = 100; height = 100;
  constructor(public url: string) {}
  static cached(url: string) { let texture = textureCache.get(url); if (!texture || texture.destroyed) { texture = new Texture(url); textureCache.set(url, texture); } return texture; }
  static async fromURL(url: string) { return imageLoader ? imageLoader(url) : Texture.cached(url); }
  destroy(base = false) { this.destroyCalls++; if (this.destroyed) return; this.destroyed = true; if (base) this.baseTexture?.destroy(); this.baseTexture = null; if (textureCache.get(this.url) === this) textureCache.delete(this.url); }
}
export class RenderTexture extends Texture {
  constructor(width: number, height: number) { super(`render:${width}x${height}`); this.width = width; this.height = height; }
  static create(options: { width: number; height: number }) { return new RenderTexture(options.width, options.height); }
}
export class Sprite extends Container {
  anchor = new Vector();
  constructor(public texture: Texture = Texture.EMPTY) { super(); }
  destroy(options?: { children?: boolean; texture?: boolean; baseTexture?: boolean }) { if (options?.texture) this.texture.destroy(options.baseTexture); super.destroy(options); }
}
export class Text extends Sprite {
  constructor(public text: string, public style: Record<string, any>) { super(); }
}
export const loadedModels: Live2DModel[] = [];
export const compositeConfigured: Array<{ model: Live2DModel; autoUpdate: boolean; deltaTime: number; visible: boolean }> = [];
let modelLoader: ((url: string, options: any) => Promise<Live2DModel>) | null = null;
export function setModelLoader(loader: (url: string, options: any) => Promise<Live2DModel>) { modelLoader = loader; }
export function setImageLoader(loader: (url: string) => Promise<Texture>) { imageLoader = loader; }
export class Live2DModel extends Container {
  anchor = new Vector(); autoUpdate = true; autoInteract = true; deltaTime = 70;
  textures: Texture[]; stopped = false;
  internalModel: any;
  constructor(public url: string) {
    super(); this.textures = [Texture.cached(`${url}:texture`)];
    const parameters = { ids: ["ParamAngleX", "ParamMouthOpenY", "ParamPhysics"], minimumValues: [-100, 0, -100], maximumValues: [100, 1, 100], defaultValues: [0, 0, 0], values: new Float32Array(3) };
    this.internalModel = {
      motionManager: { stopAllMotions: () => { this.stopped = true; } }, settings: {},
      coreModel: { parameters, parts: { ids: [], opacities: new Float32Array() }, update() {} },
      physics: { velocity: 0, evaluate(core: any, dt: number) { this.velocity += dt * (core.parameters.values[0] - this.velocity); core.parameters.values[2] = this.velocity; } },
    };
    loadedModels.push(this);
  }
  static async from(url: string, options: any = {}) {
    const model = modelLoader ? await modelLoader(url, options) : new Live2DModel(url);
    model.autoUpdate = options.autoUpdate ?? true; model.autoInteract = options.autoInteract ?? true;
    return model;
  }
}
export function resolveCompositePath(path: string, source: string) { return new URL(path, source).href; }
export async function loadPixiCompositeModel(options: any) {
  const container = options.createContainer();
  const parts = JSON.parse(options.jsonlText).parts;
  const models: Live2DModel[] = [];
  for (const [modelIndex, part] of parts.entries()) {
    const resolvedUrl = await options.resolveAssetUrl(part, { source: options.source });
    const model = await Live2DModel.from(resolvedUrl, { autoInteract: false });
    model.visible = false; // The real composite loader hides parts until configureModel.
    model.visible = false;
    container.addChild(model);
    await options.configureModel({ model, part, resolvedUrl, modelIndex });
    compositeConfigured.push({ model, autoUpdate: model.autoUpdate, deltaTime: model.deltaTime, visible: model.visible });
    models.push(model);
  }
  return { container, models };
}
export function resetSceneMocks() { loadedModels.length = 0; compositeConfigured.length = 0; modelLoader = null; imageLoader = null; textureCache.clear(); }
export function makeApp(width = 1920, height = 1080) {
  const events: any[] = [];
  const renderer = { backgroundAlpha: 1, render(container: Container, options?: any) {
    events.push({ container, renderTexture: options?.renderTexture, backgroundAlpha: this.backgroundAlpha, clear: options?.clear, children: container.children.filter((child) => child.visible).map((child: any) => ({ display: child, texture: child.texture, text: child.text, style: child.style ? { ...child.style } : undefined, position: { ...child.position }, scale: { ...child.scale }, rotation: child.rotation, alpha: child.alpha })) });
  } };
  return { app: { screen: { width, height }, stage: new Container(), renderer }, events };
}
