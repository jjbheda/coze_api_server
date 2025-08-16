// scripts/build.js  (ESM)
import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import * as tar from 'tar'; // ← 关键：用命名空间导入

// 按需增删：把需要发布的文件/目录列出来
const include = [
  'server.js',
  'package.json',
  'package-lock.json',
  'ecosystem.config.cjs', // 若用 PM2
  'src', 'routes', 'middlewares'
];

rmSync('release', { recursive: true, force: true });

mkdirSync('release', { recursive: true });

for (const p of include) {
  if (existsSync(p)) cpSync(p, `release/${p}`, { recursive: true });
}

// 生成 release.tar.gz
await tar.c({ gzip: true, file: 'release.tar.gz', cwd: 'release' }, ['.']);
console.log('✅ 已生成 release.tar.gz');
