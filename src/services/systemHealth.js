import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function getDiskPressureStatus() {
  const targetPath = path.resolve(__dirname, '../..');
  try {
    const stats = await fs.statfs(targetPath);
    const totalBytes = Number(stats.blocks || 0) * Number(stats.bsize || 0);
    const availableBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const blockPercent = Math.max(1, Number(config.diskPressureBlockPercent) || 95);
    const warnPercent = Math.max(1, Number(config.diskPressureWarnPercent) || 90);
    const pressured = usedPercent >= blockPercent;
    const warning = usedPercent >= warnPercent;

    return {
      ok: !pressured,
      pressured,
      warning,
      path: targetPath,
      usedPercent: Number(usedPercent.toFixed(2)),
      totalBytes,
      availableBytes,
      warnPercent,
      blockPercent,
    };
  } catch (error) {
    return {
      ok: true,
      pressured: false,
      warning: false,
      path: targetPath,
      error: error?.message || String(error),
    };
  }
}
