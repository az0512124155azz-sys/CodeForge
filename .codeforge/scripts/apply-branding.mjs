import fs from 'node:fs';
import path from 'node:path';

const productPath = path.resolve('product.json');
if (!fs.existsSync(productPath)) {
  throw new Error('product.json not found. Run this script from the Code-OSS repository root.');
}

const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
product.nameShort = 'CodeForge';
product.nameLong = 'CodeForge';
product.applicationName = 'codeforge';
product.dataFolderName = '.codeforge';
product.win32MutexName = 'codeforge';
product.win32RegValueName = 'CodeForge';
product.win32DirName = 'CodeForge';
product.win32NameVersion = 'CodeForge';
product.win32AppUserModelId = 'CodeForge.CodeForge';
product.win32ShellNameShort = 'CodeForge';
product.darwinBundleIdentifier = 'dev.codeforge.ide';
product.linuxIconName = 'codeforge';

fs.writeFileSync(productPath, JSON.stringify(product, null, 2) + '\n');

const packagePath = path.resolve('package.json');
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.name = 'codeforge';
  pkg.productName = 'CodeForge';
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Applied initial CodeForge product branding.');
