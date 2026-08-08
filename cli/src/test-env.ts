/**
 * CLI test-environment bootstrap.
 *
 * Must evaluate before any module that imports `@savant-code/common/env`: that
 * module snapshots `NEXT_PUBLIC_CB_ENVIRONMENT` at load time, and
 * `getConfigDir()` only honors the `SAVANT_CODE_CONFIG_DIR` test override when
 * the environment is not `prod`.
 *
 * The public-release pipeline applies the canonical public profile
 * (`NEXT_PUBLIC_CB_ENVIRONMENT=prod`) to gate processes, so without this
 * pin the config-dir-dependent provider/settings tests would silently point
 * at the real `~/.savant-code/` directory instead of their isolated temp dir.
 */
process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'dev'
