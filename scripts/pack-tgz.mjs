#!/usr/bin/env node
/**
 * Build this project and pack it into the folder ABOVE the checkout —
 * `my-plugin/` — so every build lands beside the source tree.
 *
 * The tarball is only the install source: DSH runs the copy pnpm puts in
 * `$DSH_HOME/profiles/<profile>/node_modules/<name>/`.
 *
 * Everything runs through `npm_execpath`, so the script never depends on
 * `pnpm` being on PATH: launch it as `pnpm run pack:tgz`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..') // .../my-plugin/dsh-custom-js
const outDir = resolve(root, '..') // .../my-plugin
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const pnpmEntry = process.env.npm_execpath
const viaEntry = pnpmEntry !== undefined && pnpmEntry.endsWith('.mjs')

function runPnpm(args) {
  if (viaEntry) {
    execFileSync(process.execPath, [pnpmEntry, ...args], { cwd: root, stdio: 'inherit' })
  } else {
    execFileSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  }
}

// Rebuild first: the tarball ships `lib/`, so a stale build must never be packed.
runPnpm(['run', 'build'])

mkdirSync(outDir, { recursive: true })
runPnpm(['pack', '--pack-destination', outDir])

const target = join(outDir, `${pkg.name}-${pkg.version}.tgz`)
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex').toUpperCase()
console.log(`\ntarball : ${target}`)
console.log(`version : ${pkg.version}`)
console.log(`sha256  : ${sha256}`)
console.log(`profile : "${pkg.name}": "file:${target.replaceAll('\\', '/')}"`)
