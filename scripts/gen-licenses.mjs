// Collects the license text of every production dependency (including
// transitive ones) into build/THIRD_PARTY_LICENSES.txt, which electron-builder
// packages into the app's resources. Electron's own LICENSE and Chromium's
// LICENSES.chromium.html are added to the package root by electron-builder
// automatically, so they are not duplicated here.
// Run: node scripts/gen-licenses.mjs  (part of `npm run build`)
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const tree = JSON.parse(
  execSync('npm ls --omit=dev --all --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
)

/** Flatten the npm ls tree into unique name -> {version, path} (first wins). */
const packages = new Map()
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (!packages.has(name) && !info.missing) {
      // npm ls --json omits install paths; hoisted flat layout means the
      // package lives at node_modules/<name> (scoped names included).
      packages.set(name, { version: info.version ?? 'unknown', path: join('node_modules', name) })
    }
    walk(info.dependencies)
  }
}
walk(tree.dependencies)

const LICENSE_FILENAMES = /^(license|licence|copying)(\.(md|txt|markdown))?$/i

function findLicenseText(pkgPath) {
  if (!pkgPath || !existsSync(pkgPath)) return null
  for (const entry of readdirSync(pkgPath)) {
    if (LICENSE_FILENAMES.test(entry)) {
      return readFileSync(join(pkgPath, entry), 'utf8')
    }
  }
  return null
}

function licenseField(pkgPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
    return typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)
  } catch {
    return 'unknown'
  }
}

const sections = []
const missing = []
for (const [name, { version, path }] of [...packages.entries()].sort()) {
  // optional deps npm lists but never installed (e.g. ws's native addons)
  if (!existsSync(join(path, 'package.json'))) continue
  const spdx = licenseField(path)
  const text = findLicenseText(path)
  const header = `${'='.repeat(72)}\n${name}@${version} — ${spdx}\n${'='.repeat(72)}`
  if (text) {
    sections.push(`${header}\n\n${text.trim()}\n`)
  } else {
    // No license file shipped in the package: record the SPDX identifier.
    sections.push(`${header}\n\n(Package declares license "${spdx}" but ships no license file.)\n`)
    missing.push(`${name}@${version}`)
  }
}

const banner = `THIRD-PARTY LICENSES for "No Mic? No Problem"
Generated from production dependencies on build.

Electron's LICENSE and the full Chromium third-party license bundle
(LICENSES.chromium.html) are included alongside the application binary
by the packager.

node-forge is dual-licensed BSD-3-Clause or GPL-2.0; it is used here
under the BSD-3-Clause option.

${'#'.repeat(72)}
`

mkdirSync('build', { recursive: true })
writeFileSync('build/THIRD_PARTY_LICENSES.txt', banner + '\n' + sections.join('\n'))
console.log(
  `wrote build/THIRD_PARTY_LICENSES.txt (${packages.size} packages${missing.length ? `; no license file: ${missing.join(', ')}` : ''})`
)
