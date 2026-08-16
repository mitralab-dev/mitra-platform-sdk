# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Re-export the deprecated `mitra-interactions-sdk` surface from the package entrypoint.
- Share one session between this SDK and the legacy SDK in both directions.
- Make the SonarCloud job wait for the Quality Gate result.
- Align the public package metadata and ESM, CommonJS, and TypeScript artifacts.
- Add package shape checks and public tarball smoke coverage.
- Correct public imports and required configuration in documentation examples.
- Add the MIT license.

## 1.0.8

- Share environment-neutral API contracts through `@mitralab.io/sdk-core`.
- Preserve the Platform SDK 1.x browser authentication and entity facade.
- Validate redirects, API errors, sensitive-value redaction, and package consumers.
