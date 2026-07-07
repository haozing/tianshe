# Remote Web Deploy Environments

Active deploy configs use only the clean remote Web origins.

## Required Origin Keys

- `newRemoteWebOrigin`
- `remoteConfigUrl`
- `remoteAssetsBase`
- `diagnosticsUploadUrl`

## Create A Sample

```powershell
node remote-web/scripts/init-deploy-env-config.mjs --env test --sample --print
```

## Create A Real Config

```powershell
node remote-web/scripts/init-deploy-env-config.mjs --env test --real --new-origin https://test-new.example.com/ --diagnostics-upload-url https://test-upload.example.com/
```

Replace example domains with real environment domains before writing `test.json`, `staging.json`, or `production.json`.
