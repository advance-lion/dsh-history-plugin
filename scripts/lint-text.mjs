/**
 * 文本完整性检查：中文注释多的代码库最容易悄悄坏在编码上。
 *
 * 检查三件事（输出刻意只用 ASCII，免得 PowerShell 把中文结果弄乱）：
 *   1. 有没有 U+FFFD 替换字符（编码损坏的典型痕迹）
 *   2. 有没有控制字符 / 孤立代理对（复制粘贴带进来的脏字节）
 *   3. 每个 .json 能不能解析
 *
 * 用法：node scripts/lint-text.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', '_probe', 'accounts'])
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt'])

/** 递归收集文本文件。 */
function walk(directory, out = []) {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue
    const full = join(directory, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (TEXT.has(extname(name))) out.push(full)
  }
  return out
}

const files = walk(root)
const problems = []

for (const file of files) {
  const show = relative(root, file).replaceAll('\\', '/')
  const text = readFileSync(file, 'utf8')
  if (text.includes('\uFFFD')) problems.push(`${show}: replacement char U+FFFD`)
  // 控制字符（制表、换行、回车除外）。
  const control = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
  if (control !== null) problems.push(`${show}: control char U+${control[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  // 孤立代理对。
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) problems.push(`${show}: lone high surrogate at ${index}`)
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      problems.push(`${show}: lone low surrogate at ${index}`)
    }
  }
  if (extname(file) === '.json') {
    try {
      JSON.parse(text)
    } catch (error) {
      problems.push(`${show}: invalid JSON - ${error.message}`)
    }
  }
}

console.log(`scanned ${files.length} text files`)
if (problems.length === 0) {
  console.log('text integrity: clean')
  process.exit(0)
}
for (const problem of problems) console.log(`PROBLEM ${problem}`)
console.log(`text integrity: ${problems.length} problem(s)`)
process.exit(1)
