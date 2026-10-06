// scripts/bump-version.mjs
// 把 package.json 的 patch 版本号 +1，再写回
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const [maj, min, pat] = pkg.version.split('.').map(Number);
const next = `${maj}.${min}.${pat + 1}`;
pkg.version = next;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[bump-version] ${pkg.name}: ${maj}.${min}.${pat} -> ${next}`);