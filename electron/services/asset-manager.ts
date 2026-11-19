/**
 * 可下载资源管理器
 * 负责把大文件从远程拉取到 userData/assets，减少安装包体积。
 * 支持单文件下载、镜像回退、断点续传、校验、zip 解压，以及 7z 分卷下载/合并/解压。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { path7za } from '7zip-bin';
import { ASSETS_DIR, ensureDirExists, resolveAssetPath } from '../utils/helpers';
import { AssetItem, AssetPart, getAssetById, getAllAssets } from '../config/assets';

export interface DownloadProgress {
  assetId: string;
  downloaded: number;
  total: number;
  percent: number;
  /** 实时下载速度（字节/秒），暂停或未下载时为 0 */
  speedBps: number;
  /** downloading=下载中（有实时速度）；paused=已暂停/断点可续传（速度为 0） */
  status: 'downloading' | 'paused';
}

type ProgressCallback = (progress: DownloadProgress) => void;
type DoneCallback = (assetId: string, success: boolean, error?: string) => void;

const progressListeners: ProgressCallback[] = [];
const doneListeners: DoneCallback[] = [];

/** 内存中的下载进度缓存，供前端轮询使用 */
const downloadProgressMap = new Map<string, DownloadProgress>();

/** 网速采样：每个资源保留最近一段时间的 {时间, 已下载字节}，用于滑动窗口计算实时速度 */
interface SpeedSample { t: number; bytes: number; }
const speedSamples = new Map<string, SpeedSample[]>();
const SPEED_WINDOW_MS = 2000;
/** 超过该速率（字节/毫秒，约 500 MB/s）视为采样不连续，重置窗口避免瞬时虚高 */
const SPEED_DISCONTINUITY_BPMS = 500 * 1024;

function resetSpeedSamples(assetId: string): void {
  speedSamples.delete(assetId);
  const cur = downloadProgressMap.get(assetId);
  if (cur) cur.speedBps = 0;
}

/** 记录一次进度采样并返回当前滑动窗口平均速度（字节/秒） */
function recordSpeed(assetId: string, downloaded: number): number {
  const now = Date.now();
  let samples = speedSamples.get(assetId);
  if (!samples) {
    samples = [];
    speedSamples.set(assetId, samples);
  }
  const last = samples[samples.length - 1];
  if (last) {
    const dt = now - last.t;
    const db = downloaded - last.bytes;
    // 回退（服务端不支持 Range 重新开始）或瞬时跳变过快 → 重置窗口
    if (db < 0 || (dt > 0 && db / dt > SPEED_DISCONTINUITY_BPMS)) {
      samples.length = 0;
    }
  }
  samples.push({ t: now, bytes: downloaded });
  while (samples.length > 1 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
  if (samples.length < 2) return 0;
  const first = samples[0];
  const dt = (now - first.t) / 1000;
  if (dt <= 0) return 0;
  return Math.max(0, (downloaded - first.bytes) / dt);
}

export function onProgress(cb: ProgressCallback): () => void {
  progressListeners.push(cb);
  return () => {
    const idx = progressListeners.indexOf(cb);
    if (idx >= 0) progressListeners.splice(idx, 1);
  };
}

export function onDone(cb: DoneCallback): () => void {
  doneListeners.push(cb);
  return () => {
    const idx = doneListeners.indexOf(cb);
    if (idx >= 0) doneListeners.splice(idx, 1);
  };
}

/** 获取指定资源的当前下载进度（含磁盘上的断点续传状态） */
export function getDownloadProgress(assetId: string): DownloadProgress | undefined {
  const live = downloadProgressMap.get(assetId);
  if (live) return live;
  if (isAssetDownloaded(assetId)) return undefined;
  const partial = getAssetPartialProgress(assetId);
  if (partial) {
    return {
      assetId,
      downloaded: partial.downloaded,
      total: partial.total,
      percent: partial.percent,
      speedBps: 0,
      status: 'paused',
    };
  }
  return undefined;
}

/** 获取所有下载进度：进行中的实时进度 + 磁盘上可续传的断点（暂停态） */
export function getAllDownloadProgress(): Map<string, DownloadProgress> {
  const result = new Map<string, DownloadProgress>(downloadProgressMap);
  for (const asset of getAllAssets()) {
    if (result.has(asset.id)) continue;
    if (isAssetDownloaded(asset.id)) continue;
    const partial = getAssetPartialProgress(asset.id);
    if (partial) {
      result.set(asset.id, {
        assetId: asset.id,
        downloaded: partial.downloaded,
        total: partial.total,
        percent: partial.percent,
        speedBps: 0,
        status: 'paused',
      });
    }
  }
  return result;
}

function emitProgress(assetId: string, downloaded: number, total: number) {
  const percent = total > 0 ? Math.round((downloaded / total) * 1000) / 10 : 0;
  const speedBps = recordSpeed(assetId, downloaded);
  const p: DownloadProgress = { assetId, downloaded, total, percent, speedBps, status: 'downloading' };
  downloadProgressMap.set(assetId, p);
  for (const cb of progressListeners) {
    try { cb(p); } catch {}
  }
}

function emitDone(assetId: string, success: boolean, error?: string) {
  resetSpeedSamples(assetId);
  const current = downloadProgressMap.get(assetId);
  if (current) {
    if (success) {
      downloadProgressMap.set(assetId, { ...current, downloaded: current.total, percent: 100, speedBps: 0 });
    } else {
      // 失败时保留已下载字节数，标记为可续传的暂停态
      downloadProgressMap.set(assetId, { ...current, speedBps: 0, status: 'paused' });
    }
  }
  for (const cb of doneListeners) {
    try { cb(assetId, success, error); } catch {}
  }
}

/** 某个资源是否已经下载到用户数据目录 */
export function isAssetDownloaded(assetId: string): boolean {
  const asset = getAssetById(assetId);
  if (!asset) return false;

  const localFile = path.join(ASSETS_DIR, asset.localPath);
  if (fs.existsSync(localFile)) {
    // zip 包还需要确认解压后的目录存在
    if (localFile.endsWith('.zip')) {
      const extractedDir = localFile.replace(/\.zip$/, '');
      return fs.existsSync(extractedDir);
    }
    return true;
  }
  return false;
}

/** 资源是否可用（已下载 或 安装包内自带） */
export function isAssetAvailable(assetId: string): boolean {
  if (isAssetDownloaded(assetId)) return true;
  const asset = getAssetById(assetId);
  if (!asset) return false;
  // 检查安装目录/项目目录是否已有该资源
  const bundledPath = resolveAssetPath(asset.localPath);
  if (bundledPath && fs.existsSync(bundledPath)) {
    if (asset.localPath.endsWith('.zip')) {
      const extractedDir = bundledPath.replace(/\.zip$/, '');
      return fs.existsSync(extractedDir);
    }
    return true;
  }
  return false;
}

/** 获取资源的本地文件路径（已下载）或空字符串 */
export function getAssetLocalPath(assetId: string): string {
  const asset = getAssetById(assetId);
  if (!asset) return '';
  const localFile = path.join(ASSETS_DIR, asset.localPath);
  if (fs.existsSync(localFile)) return localFile;
  return '';
}

/** 删除用户数据目录中已下载的资源（保留安装包自带资源） */
export function deleteAsset(assetId: string): { success: boolean; message: string } {
  const asset = getAssetById(assetId);
  if (!asset) return { success: false, message: '资源不存在' };

  // 先取消可能正在进行的下载
  pauseAssetDownload(assetId);

  const localFile = path.join(ASSETS_DIR, asset.localPath);
  let deleted = false;

  try {
    if (fs.existsSync(localFile)) {
      const stat = fs.statSync(localFile);
      if (stat.isDirectory()) {
        fs.rmSync(localFile, { recursive: true, force: true });
      } else {
        fs.unlinkSync(localFile);
        // zip/7z 资源还要清理解压后的目录
        if (asset.localPath.endsWith('.zip')) {
          const extractedDir = localFile.replace(/\.zip$/, '');
          try { fs.rmSync(extractedDir, { recursive: true, force: true }); } catch {}
        }
      }
      deleted = true;
    }

    // 清理可能存在的临时下载文件
    const tmpFile = `${localFile}.tmp`;
    if (fs.existsSync(tmpFile)) {
      try { fs.rmSync(tmpFile, { recursive: true, force: true }); } catch {}
    }

    // 清理分卷临时文件
    if (asset.parts && asset.parts.length > 0) {
      const partDir = path.join(ASSETS_DIR, '.downloads', asset.id);
      if (fs.existsSync(partDir)) {
        try { fs.rmSync(partDir, { recursive: true, force: true }); } catch {}
      }
    }

    // 清理内存中的进度状态与网速采样
    downloadProgressMap.delete(assetId);
    resetSpeedSamples(assetId);

    return { success: true, message: deleted ? '已删除资源' : '资源不存在于下载目录' };
  } catch (e: any) {
    return { success: false, message: e.message || '删除失败' };
  }
}

/** 单个 URL 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** 正在进行的下载请求控制器（用于暂停/取消） */
const activeDownloadControllers = new Map<string, AbortController>();

/** 暂停指定资源的下载 */
export function pauseAssetDownload(assetId: string): boolean {
  const controller = activeDownloadControllers.get(assetId);
  if (controller) {
    controller.abort();
    activeDownloadControllers.delete(assetId);
    // 保留进度，标记为暂停态，前端据此显示“继续下载”
    const cur = downloadProgressMap.get(assetId);
    if (cur) {
      downloadProgressMap.set(assetId, { ...cur, speedBps: 0, status: 'paused' });
    }
    resetSpeedSamples(assetId);
    console.log(`[asset-manager] 已暂停资源下载: ${assetId}`);
    return true;
  }
  // 没有活动控制器：说明当前没有真正在下载。若进度图里仍残留“下载中”的陈旧条目
  // （例如下载异常退出时未归一化），兜底归一为“暂停”态，让前端回到“继续下载”，无需重启
  const stale = downloadProgressMap.get(assetId);
  if (stale && stale.status !== 'paused') {
    downloadProgressMap.set(assetId, { ...stale, speedBps: 0, status: 'paused' });
    resetSpeedSamples(assetId);
    console.log(`[asset-manager] 归一化残留下载进度为暂停态: ${assetId}`);
    return true;
  }
  return false;
}

function createDownloadController(assetId: string): AbortController {
  // 如果已有控制器，先 abort 旧的
  pauseAssetDownload(assetId);
  const controller = new AbortController();
  activeDownloadControllers.set(assetId, controller);
  return controller;
}

function clearDownloadController(assetId: string): void {
  activeDownloadControllers.delete(assetId);
}

/** 下载单个资源（单文件 / 分卷 / 镜像 / 校验） */
export async function downloadAsset(assetId: string): Promise<void> {
  const asset = getAssetById(assetId);
  if (!asset) throw new Error(`未知资源: ${assetId}`);

  ensureDirExists(ASSETS_DIR);

  // 如果该资源已在下载中，直接返回，避免重复启动
  if (activeDownloadControllers.has(assetId)) {
    console.log(`[asset-manager] 资源 ${assetId} 正在下载中，忽略重复请求`);
    return;
  }

  const controller = createDownloadController(assetId);

  try {
    // 分卷资源
    if (asset.parts && asset.parts.length > 0) {
      try {
        await downloadMultipartAsset(asset, controller.signal);
        return;
      } catch (err: any) {
        // 用户主动暂停：pauseAssetDownload 已把进度归一为“暂停”态，直接抛出即可
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          throw err;
        }
        // 兜底：任何未在 downloadUrl 内归一化的异常（如解压失败、未知错误），
        // 都标记为可续传的暂停态，避免进度残留“下载中”导致会话内无法继续
        emitDone(assetId, false, err.message || String(err));
        throw err;
      }
    }

    // 单文件资源
    const urls = [asset.url, ...(asset.mirrors || [])].filter(Boolean) as string[];
    if (urls.length === 0) {
      throw new Error(`资源 ${assetId} 未配置下载地址（ASSETS_BASE_URL 为空且无镜像）`);
    }

    const tmpFile = path.join(ASSETS_DIR, `${asset.localPath}.tmp`);
    const finalFile = path.join(ASSETS_DIR, asset.localPath);

    let lastError: Error | undefined;

    for (const url of urls) {
      try {
        // 简单断点续传：先尝试从已有 .tmp 大小续传
        let startByte = 0;
        if (fs.existsSync(tmpFile)) {
          startByte = fs.statSync(tmpFile).size;
        }

        await downloadUrl(url, assetId, asset.size, tmpFile, finalFile, startByte, controller.signal);

        // 下载完成后校验（如果配置了 md5/sha256）
        if (asset.md5 || asset.sha256) {
          await verifyChecksum(finalFile, asset);
        }

        if (finalFile.endsWith('.zip')) {
          extractZip(finalFile);
        }

        emitDone(assetId, true);
        return;
      } catch (err: any) {
        // 如果是用户主动暂停，直接抛出，不再尝试其他 URL
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          throw err;
        }
        console.warn(`[asset-manager] 从 ${url} 下载 ${assetId} 失败:`, err.message || err);
        lastError = err;
        // 保留 .tmp 断点供下次续传；仅当临时文件异常超过预期大小时才清理，避免追加到损坏文件
        try {
          if (fs.existsSync(tmpFile) && asset.size > 0 && fs.statSync(tmpFile).size > asset.size) {
            fs.unlinkSync(tmpFile);
          }
        } catch {}
      }
    }

    const msg = lastError?.message || '所有下载地址均失败';
    emitDone(assetId, false, msg);
    throw new Error(`下载 ${assetId} 失败: ${msg}`);
  } finally {
    clearDownloadController(assetId);
  }
}

/** 下载分卷资源：逐卷下载、合并、解压 */
async function downloadMultipartAsset(asset: AssetItem, signal?: AbortSignal): Promise<void> {
  const parts = asset.parts!;
  const totalSize = asset.size || parts.reduce((sum, p) => sum + p.size, 0);
  const partDir = path.join(ASSETS_DIR, '.downloads', asset.id);
  ensureDirExists(partDir);

  let downloadedTotal = 0;

  for (const part of parts) {
    // 如果已触发暂停/取消，提前退出
    if (signal?.aborted) {
      throw new Error('aborted');
    }

    const partFile = path.join(partDir, part.filename);
    const tmpFile = `${partFile}.tmp`;

    // 分卷已完整存在则跳过
    if (fs.existsSync(partFile) && fs.statSync(partFile).size === part.size) {
      downloadedTotal += part.size;
      emitProgress(asset.id, downloadedTotal, totalSize);
      continue;
    }

    // 删除可能存在的旧 final，以 .tmp 续传
    try { fs.unlinkSync(partFile); } catch {}
    let startByte = 0;
    if (fs.existsSync(tmpFile)) startByte = fs.statSync(tmpFile).size;

    await downloadUrl(
      part.url,
      asset.id,
      part.size,
      tmpFile,
      partFile,
      startByte,
      signal,
      (downloaded) => emitProgress(asset.id, downloadedTotal + downloaded, totalSize)
    );

    downloadedTotal += part.size;
  }

  // 所有分卷就绪后解压
  const firstPart = path.join(partDir, parts[0].filename);
  const finalOutput = path.join(ASSETS_DIR, asset.localPath);
  if (!fs.existsSync(finalOutput)) {
    extract7z(firstPart, ASSETS_DIR);
  }

  // 清理分卷临时目录
  try { fs.rmSync(partDir, { recursive: true, force: true }); } catch {}

  emitDone(asset.id, true);
}

function downloadUrl(
  url: string,
  assetId: string,
  assetSize: number,
  tmpFile: string,
  finalFile: string,
  startByte: number = 0,
  signal?: AbortSignal,
  onProgressCb?: (downloaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 如果已触发暂停/取消，直接拒绝
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const headers: Record<string, string> = {
      'User-Agent': 'shici-asset-downloader/2.0',
    };
    if (startByte > 0) {
      headers['Range'] = `bytes=${startByte}-`;
    }

    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers, signal: signal as any }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        if (loc) {
          const nextUrl = new URL(loc, url).toString();
          downloadUrl(nextUrl, assetId, assetSize, tmpFile, finalFile, startByte, signal, onProgressCb).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        const msg = `下载失败，HTTP ${res.statusCode}: ${url}`;
        // 归一化进度：标记为可续传的暂停态，避免残留“下载中”导致会话内无法继续
        emitDone(assetId, false, msg);
        reject(new Error(msg));
        return;
      }

      // 如果服务端不支持 Range 却返回了 200，丢弃之前的临时文件重新下载
      let effectiveStartByte = startByte;
      if (res.statusCode === 200 && startByte > 0) {
        try { fs.unlinkSync(tmpFile); } catch {}
        effectiveStartByte = 0;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10) + effectiveStartByte || assetSize;
      let downloaded = effectiveStartByte;

      const writeFlags = effectiveStartByte > 0 ? { flags: 'a' } : { flags: 'w' };
      const fileStream = createWriteStream(tmpFile, writeFlags);

      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (onProgressCb) {
          onProgressCb(downloaded, total);
        } else {
          emitProgress(assetId, downloaded, total);
        }
      });

      pipeline(res, fileStream)
        .then(() => {
          fs.renameSync(tmpFile, finalFile);
          resolve();
        })
        .catch((err) => {
          // 主动暂停时不视为失败
          if (err.name === 'AbortError' || err.message?.includes('aborted')) {
            reject(err);
            return;
          }
          emitDone(assetId, false, err.message);
          reject(err);
        });
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`下载超时: ${url}`));
    });

    req.on('error', (err) => {
      // 主动暂停时不视为失败
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        reject(err);
        return;
      }
      emitDone(assetId, false, err.message);
      reject(err);
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
      }, { once: true });
    }
  });
}

async function verifyChecksum(filePath: string, asset: AssetItem): Promise<void> {
  const algorithm = asset.sha256 ? 'sha256' : 'md5';
  const expected = asset.sha256 || asset.md5;
  if (!expected) return;

  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), hash as unknown as NodeJS.WritableStream);
  const actual = hash.digest('hex');

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`文件校验失败 (${algorithm}): 期望 ${expected}，实际 ${actual}`);
  }
}

function extractZip(zipPath: string): void {
  const targetDir = zipPath.replace(/\.zip$/, '');
  ensureDirExists(targetDir);
  // 统一用 7zip-bin 的 7za 解压（7za 支持 zip），三平台通用，不依赖 Windows powershell
  const bin = path7za;
  if (!bin || !fs.existsSync(bin)) {
    throw new Error('找不到 7za 解压工具，无法解压 zip');
  }
  try {
    const result = spawnSync(bin, ['x', '-y', `-o${targetDir}`, zipPath], { stdio: 'ignore' });
    if (result.status !== 0) {
      throw new Error(`7za 解压 zip 失败，退出码 ${result.status}`);
    }
    // 解压成功后可以删除 zip 节省空间
    try { fs.unlinkSync(zipPath); } catch {}
  } catch (e: any) {
    console.error(`解压 ${zipPath} 失败:`, e.message);
    throw e;
  }
}

/** 使用 7za 解压分卷 7z（指定第一个分卷即可） */
function extract7z(firstPartPath: string, outputDir: string): void {
  ensureDirExists(outputDir);
  const bin = path7za;
  if (!bin || !fs.existsSync(bin)) {
    throw new Error('找不到 7za 解压工具，无法解压 .7z 分卷包');
  }
  try {
    const result = spawnSync(bin, ['x', '-y', `-o${outputDir}`, firstPartPath], { stdio: 'ignore' });
    if (result.status !== 0) {
      throw new Error(`7za 解压失败，退出码 ${result.status}`);
    }
  } catch (e: any) {
    console.error(`解压 ${firstPartPath} 失败:`, e.message);
    throw e;
  }
}

/** 下载所有必需资源 */
export async function downloadRequiredAssets(): Promise<void> {
  const { getRequiredAssets } = await import('../config/assets');
  const required = getRequiredAssets();
  for (const asset of required) {
    if (isAssetAvailable(asset.id)) {
      console.log(`[asset-manager] 必需资源已就绪: ${asset.name}`);
      continue;
    }
    const hasSource = asset.url || (asset.mirrors && asset.mirrors.length > 0) || (asset.parts && asset.parts.length > 0);
    if (!hasSource) {
      console.warn(`[asset-manager] 必需资源 ${asset.name} 未配置下载地址，也未在本地找到。请在环境变量 ASSETS_BASE_URL 中配置 CDN 地址，或配置 mirrors。`);
      continue;
    }
    console.log(`[asset-manager] 开始下载必需资源: ${asset.name}`);
    await downloadAsset(asset.id);
  }
}

/** 扫描磁盘上的临时下载文件，计算某个资源的断点续传进度（未完成时返回） */
export function getAssetPartialProgress(
  assetId: string
): { downloaded: number; total: number; percent: number } | null {
  const asset = getAssetById(assetId);
  if (!asset) return null;

  const total = asset.size || 0;
  let downloaded = 0;
  let found = false;

  try {
    if (asset.parts && asset.parts.length > 0) {
      const partDir = path.join(ASSETS_DIR, '.downloads', asset.id);
      for (const part of asset.parts) {
        const partFile = path.join(partDir, part.filename);
        const tmpFile = `${partFile}.tmp`;
        if (fs.existsSync(partFile) && fs.statSync(partFile).size === part.size) {
          downloaded += part.size;
          found = true;
        } else if (fs.existsSync(tmpFile)) {
          const sz = fs.statSync(tmpFile).size;
          downloaded += sz;
          if (sz > 0) found = true;
        }
      }
    } else {
      const tmpFile = path.join(ASSETS_DIR, `${asset.localPath}.tmp`);
      if (fs.existsSync(tmpFile)) {
        downloaded = fs.statSync(tmpFile).size;
        if (downloaded > 0) found = true;
      }
    }
  } catch {
    return null;
  }

  if (!found || downloaded <= 0) return null;
  const effTotal = total > 0 ? total : downloaded;
  if (downloaded >= effTotal) return null; // 已下完但最终文件未就位的异常态不算断点
  return {
    downloaded,
    total: effTotal,
    percent: Math.round((downloaded / effTotal) * 1000) / 10,
  };
}

/** 获取当前所有资源的状态（含断点续传信息） */
export function getAssetsStatus(): Array<
  AssetItem & {
    downloaded: boolean;
    partial: boolean;
    partialDownloaded: number;
    partialTotal: number;
    partialPercent: number;
  }
> {
  return getAllAssets().map(a => {
    const downloaded = isAssetAvailable(a.id);
    const partial = downloaded ? null : getAssetPartialProgress(a.id);
    return {
      ...a,
      downloaded,
      partial: !!partial,
      partialDownloaded: partial?.downloaded ?? 0,
      partialTotal: partial?.total ?? 0,
      partialPercent: partial?.percent ?? 0,
    };
  });
}
