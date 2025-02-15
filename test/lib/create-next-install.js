const os = require('os')
const path = require('path')
const execa = require('execa')
const fs = require('fs-extra')
const childProcess = require('child_process')
const { randomBytes } = require('crypto')
const { linkPackages } =
  require('../../.github/actions/next-stats-action/src/prepare/repo-setup')()

/**
 * These are simple dependencies provided by default. We want to optimize this special case.
 */
const areGenericDependencies = (dependencies) =>
  Object.keys(dependencies).length === 6 &&
  Object.entries(dependencies).every(([dep, version]) => {
    if (dep === 'next') return true
    return (
      [
        'react',
        'react-dom',
        'typescript',
        '@types/react',
        '@types/node',
      ].includes(dep) && version === 'latest'
    )
  })

async function createNextInstall({
  parentSpan,
  dependencies,
  installCommand,
  packageJson = {},
  packageLockPath = '',
  dirSuffix = '',
}) {
  return await parentSpan
    .traceChild('createNextInstall')
    .traceAsyncFn(async (rootSpan) => {
      const tmpDir = await fs.realpath(process.env.NEXT_TEST_DIR || os.tmpdir())
      const origRepoDir = path.join(__dirname, '../../')
      const installDir = path.join(
        tmpDir,
        `next-install-${randomBytes(32).toString('hex')}${dirSuffix}`
      )
      const tmpRepoDir = path.join(
        tmpDir,
        `next-repo-${randomBytes(32).toString('hex')}${dirSuffix}`
      )

      require('console').log('Using following temporary directories:')
      require('console').log(installDir)
      require('console').log(tmpRepoDir)

      await rootSpan.traceChild(' enruse swc binary').traceAsyncFn(async () => {
        // ensure swc binary is present in the native folder if
        // not already built
        for (const folder of await fs.readdir(
          path.join(origRepoDir, 'node_modules/@next')
        )) {
          if (folder.startsWith('swc-')) {
            const swcPkgPath = path.join(
              origRepoDir,
              'node_modules/@next',
              folder
            )
            const outputPath = path.join(
              origRepoDir,
              'packages/next-swc/native'
            )
            await fs.copy(swcPkgPath, outputPath, {
              filter: (item) => {
                return (
                  item === swcPkgPath ||
                  (item.endsWith('.node') &&
                    !fs.pathExistsSync(
                      path.join(outputPath, path.basename(item))
                    ))
                )
              },
            })
          }
        }
      })

      for (const item of ['package.json', 'packages']) {
        await rootSpan
          .traceChild(`copy ${item} to temp dir`)
          .traceAsyncFn(async () => {
            await fs.copy(
              path.join(origRepoDir, item),
              path.join(tmpRepoDir, item),
              {
                filter: (item) => {
                  return (
                    !item.includes('node_modules') &&
                    !item.includes('.DS_Store') &&
                    // Exclude Rust compilation files
                    !/next[\\/]build[\\/]swc[\\/]target/.test(item) &&
                    !/next-swc[\\/]target/.test(item)
                  )
                },
              }
            )
          })
      }

      let combinedDependencies = dependencies

      if (!(packageJson && packageJson.nextPrivateSkipLocalDeps)) {
        const pkgPaths = await linkPackages({
          repoDir: tmpRepoDir,
          parentSpan: rootSpan,
        })
        combinedDependencies = {
          next: pkgPaths.get('next'),
          ...Object.keys(dependencies).reduce((prev, pkg) => {
            const pkgPath = pkgPaths.get(pkg)
            prev[pkg] = pkgPath || dependencies[pkg]
            return prev
          }, {}),
        }
      }

      await fs.ensureDir(installDir)
      await fs.writeFile(
        path.join(installDir, 'package.json'),
        JSON.stringify(
          {
            ...packageJson,
            dependencies: combinedDependencies,
            private: true,
          },
          null,
          2
        )
      )

      if (packageLockPath) {
        await fs.copy(
          packageLockPath,
          path.join(installDir, path.basename(packageLockPath))
        )
      }

      if (installCommand) {
        const installString =
          typeof installCommand === 'function'
            ? installCommand({ dependencies: combinedDependencies })
            : installCommand

        console.log('running install command', installString)
        rootSpan.traceChild('run custom install').traceFn(() => {
          childProcess.execSync(installString, {
            cwd: installDir,
            stdio: ['ignore', 'inherit', 'inherit'],
          })
        })
      } else {
        await rootSpan
          .traceChild('run generic install command')
          .traceAsyncFn(async () => {
            const runInstall = async () =>
              await execa(
                'pnpm',
                ['install', '--strict-peer-dependencies=false'],
                {
                  cwd: installDir,
                  stdio: ['ignore', 'inherit', 'inherit'],
                  env: process.env,
                }
              )

            if (!areGenericDependencies(combinedDependencies)) {
              await runInstall()
            } else {
              const cacheDir = path.join(
                origRepoDir,
                'test',
                'tmp',
                'genericInstallCache'
              )

              const cachedFiles = [
                // We can't cache node-modules because .pnpm store must be on the same mount - we can't move it between mountpoints
                // 'node_modules',
                // FIXME: caching lock file caused itssues and It's not possible when we don't use turbo which we had to disable temporarily
                // 'pnpm-lock.yaml',
              ]

              if (
                await fs
                  .access(cacheDir)
                  .then(() => true)
                  .catch(() => false)
              ) {
                require('console').log(
                  'We are able to prepopulate pnpm install from cache'
                )
                cachedFiles.forEach((file) => {
                  fs.copy(
                    path.join(cacheDir, file),
                    path.join(installDir, file)
                  )
                })
              }

              await runInstall()

              await fs.ensureDir(cacheDir)
              cachedFiles.forEach((file) => {
                fs.copy(path.join(installDir, file), path.join(cacheDir, file))
              })
            }
          })
      }

      await fs.remove(tmpRepoDir)
      return installDir
    })
}

module.exports = {
  createNextInstall,
}
