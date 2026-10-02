import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = () => {
  if (!process.env.L2D_STORAGE_TEST_ROOT) throw new Error("test storage root is not set");
  return process.env.L2D_STORAGE_TEST_ROOT;
};
export const appDataDir = async () => path.join(root(), "managed");
export const appLocalDataDir = async () => path.join(root(), "local");
export const appCacheDir = async () => path.join(root(), "cache");
export const basename = async (value: string) => path.basename(value);
export const dirname = async (value: string) => path.dirname(value);
export const extname = async (value: string) => path.extname(value).slice(1);
export const join = async (...values: string[]) => path.join(...values);
export const readFile = async (value: string) => new Uint8Array(await fs.readFile(value));
export const readTextFile = async (value: string) => fs.readFile(value, "utf8");
export const writeFile = async (value: string, bytes: Uint8Array) => fs.writeFile(value, bytes);
export const writeTextFile = async (value: string, text: string) => fs.writeFile(value, text);
export const copyFile = async (source: string, destination: string) => fs.copyFile(source, destination);
export const rename=async (source:string,destination:string)=>fs.rename(source,destination);
export const readDir=async (value:string)=>(await fs.readdir(value,{withFileTypes:true})).map(entry=>({name:entry.name,isDirectory:entry.isDirectory(),isFile:entry.isFile()}));
export const mkdir = async (value: string, options?: { recursive?: boolean }) => fs.mkdir(value, options);
export const remove = async (value: string, options?: { recursive?: boolean }) => fs.rm(value, options);
export const stat = async (value: string) => {
  const info = await fs.stat(value);
  return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
};
export const invoke = async () => { throw new Error("native bridge must not run in storage tests"); };
