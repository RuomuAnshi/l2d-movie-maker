/* eslint-disable @typescript-eslint/no-explicit-any */
const effects: Array<() => void> = [];
export const useRef = <T>(value: T) => ({ current: value });
export const useEffect = (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) effects.push(cleanup); };
export function unmountManager() { while (effects.length) effects.shift()!(); }
class Vector { x = 0; y = 0; set(x: number, y = x) { this.x = x; this.y = y; } }
export class Container {
  children: any[] = [];
  parent: Container | null = null;
  position = new Vector(); scale = new Vector(); anchor = new Vector();
  width = 300; height = 500; destroyed = false; visible = true; sortableChildren = false;
  rotation = 0;
  addChild(child: any) { child.parent?.removeChild(child); this.children.push(child); child.parent = this; return child; }
  removeChild(child: any) { this.children = this.children.filter((item) => item !== child); child.parent = null; return child; }
  removeChildren() { const children = this.children; this.children = []; for (const child of children) child.parent = null; return children; }
  getBounds() { return { x: this.position.x, y: this.position.y, width: this.width, height: this.height }; }
  destroy() { this.destroyed = true; this.parent?.removeChild(this); this.removeChildren(); }
}
export class Graphics extends Container {}
let singleLoader: (url: string) => Promise<Live2DModel>;
let compositeLoader: (options: any) => Promise<any>;
export function setSingleLoader(load: (url: string) => Promise<Live2DModel>) { singleLoader = load; }
export function setCompositeLoader(load: (options: any) => Promise<any>) { compositeLoader = load; }
export class Live2DModel extends Container {
  autoUpdate = true; autoInteract = true; deltaTime = 100;
  stopped = false;
  internalModel = { motionManager: { stopAllMotions: () => { this.stopped = true; } }, settings: {} };
  textures: any[];
  constructor() {
    super();
    const baseTexture = { destroyed: false, destroy() { this.destroyed = true; } };
    this.textures = [{ baseTexture, destroy() { this.baseTexture = null; } }];
  }
  static from(url: string) { return singleLoader(url); }
}
export async function loadPixiCompositeModel(options: any) { return compositeLoader(options); }
export function resolveCompositePath(path: string) { return path; }
