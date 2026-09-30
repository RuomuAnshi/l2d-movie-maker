import type { Texture, BaseTexture } from "pixi.js";

type TexturedModel = { textures?: Texture[] };
const counts = new Map<BaseTexture, number>();
const models = new WeakMap<object, BaseTexture[]>();
const wrappers = new Map<BaseTexture, Set<Texture>>();
const deferred = new Set<BaseTexture>();
let outstandingLoads = 0;

/** Protect cached resources already used by a model whose async loading has not finished. */
export function beginModelResourceLoad(): () => void {
  outstandingLoads += 1;
  let ended = false;
  return () => { if (!ended) { ended = true; endModelResourceLoad(); } };
}

export function endModelResourceLoad(): void {
  outstandingLoads = Math.max(0, outstandingLoads - 1);
  flushReleasedTextures();
}

/** Models share immutable textures while keeping native parameter and physics state separate. */
export function retainModelResources(model: TexturedModel) {
  if (models.has(model)) return;
  const textures = [...new Set((model.textures ?? []).map((texture) => texture.baseTexture))];
  models.set(model, textures);
  for (const texture of model.textures ?? []) {
    let texturesForBase = wrappers.get(texture.baseTexture);
    if (!texturesForBase) { texturesForBase = new Set(); wrappers.set(texture.baseTexture, texturesForBase); }
    texturesForBase.add(texture);
  }
  for (const texture of textures) {
    counts.set(texture, (counts.get(texture) ?? 0) + 1);
    deferred.delete(texture);
  }
}

export function releaseModelResources(model: TexturedModel) {
  const textures = models.get(model);
  if (!textures) return;
  models.delete(model);
  for (const texture of textures) {
    const next = (counts.get(texture) ?? 1) - 1;
    if (next > 0) counts.set(texture, next);
    else { counts.delete(texture); deferred.add(texture); }
  }
  flushReleasedTextures();
}

function flushReleasedTextures(): void {
  if (outstandingLoads) return;
  for (const base of deferred) {
    if (counts.has(base)) continue;
    // Destroy wrappers too, so PIXI's TextureCache cannot later return a dead BaseTexture.
    for (const texture of wrappers.get(base) ?? []) if (texture.baseTexture) texture.destroy(false);
    wrappers.delete(base);
    if (!base.destroyed) base.destroy();
  }
  deferred.clear();
}
