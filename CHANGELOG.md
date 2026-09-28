# Changelog

Every release of The Artifact, newest first. Entries are generated from the commit messages when a release is made; what you have to do when you upgrade is in [Upgrading](docs/upgrading.md), and the versioning policy is there too.

## [0.2.0](https://github.com/andidev30/the-artifact/compare/v0.1.0...v0.2.0) (2026-09-28)


### Features

* access tokens for publishing from CI ([768589f](https://github.com/andidev30/the-artifact/commit/768589f2e8108d18f68e843ae60b737638915450))
* **api:** access tokens for publishing from CI ([01f807e](https://github.com/andidev30/the-artifact/commit/01f807ebdf021794cc8be3e7ef2f77cc0f3afe73)), closes [#32](https://github.com/andidev30/the-artifact/issues/32)
* **api:** comments on pages, with replies, moderation and emails ([4b3293e](https://github.com/andidev30/the-artifact/commit/4b3293eeb175cd05ec1a195db0a6e1695a7ae80c))
* **api:** delete, version history and zip download over MCP ([e8c1563](https://github.com/andidev30/the-artifact/commit/e8c15635d2ca7bf84af4f6d32ac53f0be85b6db3)), closes [#29](https://github.com/andidev30/the-artifact/issues/29)
* **api:** embed link-shared pages over oEmbed at /e/&lt;slug&gt; ([09830d3](https://github.com/andidev30/the-artifact/commit/09830d37db82213de6b64688afb56a4d4e29134e)), closes [#42](https://github.com/andidev30/the-artifact/issues/42)
* **api:** folders, cursor pagination and indexed title search for the gallery ([12e7cdc](https://github.com/andidev30/the-artifact/commit/12e7cdcbd2fd043a8e6e7a4c5aec79d577efef5c))
* **api:** health checks, JSON request logs and Prometheus metrics ([902f8a0](https://github.com/andidev30/the-artifact/commit/902f8a02364de9d3f238bdc6d5b23e7e2b75143d)), closes [#22](https://github.com/andidev30/the-artifact/issues/22)
* **api:** link previews with the page's title and screenshot ([bd36c0c](https://github.com/andidev30/the-artifact/commit/bd36c0c330813b12bc8f5f6f0c198acefc37f0d2))
* **api:** link previews with the page's title and screenshot ([f8e70bf](https://github.com/andidev30/the-artifact/commit/f8e70bf3f88387816955b125b001ad5f1b09eb67)), closes [#25](https://github.com/andidev30/the-artifact/issues/25)
* **api:** passkeys, two-factor sign-in and active sessions ([1c988b6](https://github.com/andidev30/the-artifact/commit/1c988b63a4d966cd3ff3887b361da186d3803faa)), closes [#41](https://github.com/andidev30/the-artifact/issues/41)
* **api:** publish by direct upload to storage ([9bd0452](https://github.com/andidev30/the-artifact/commit/9bd0452b16086a082255ed40d88c7994bbf25247))
* **api:** publish by direct upload to storage ([0739f54](https://github.com/andidev30/the-artifact/commit/0739f545b8d1714238fbd7d4dba751d2c4c83a5f)), closes [#52](https://github.com/andidev30/the-artifact/issues/52)
* **api:** rate limits in Postgres and workspace storage quotas ([13645b1](https://github.com/andidev30/the-artifact/commit/13645b1221bf509ff0a521505ca7714e8a90ed90))
* **api:** rate limits in Postgres and workspace storage quotas ([2107410](https://github.com/andidev30/the-artifact/commit/21074101de28ec5bd01526165f119c39efc8d59e)), closes [#21](https://github.com/andidev30/the-artifact/issues/21)
* **api:** reset two-factor sign-in from the server ([89f1ece](https://github.com/andidev30/the-artifact/commit/89f1ece25e9e4d77fe86d52f437466622cba00b8)), closes [#41](https://github.com/andidev30/the-artifact/issues/41)
* **api:** run the storage sweep from Vercel Cron ([ca563cb](https://github.com/andidev30/the-artifact/commit/ca563cb67853a46662eb2ee4a97a6c0c5e7a98aa))
* **api:** run the storage sweep from Vercel Cron ([1f8d12d](https://github.com/andidev30/the-artifact/commit/1f8d12d15fc87c3b484d7c28eee586453383021c)), closes [#58](https://github.com/andidev30/the-artifact/issues/58)
* **api:** what the CLI needs from the server ([9d23696](https://github.com/andidev30/the-artifact/commit/9d2369635688a16de08515d2a8ec987f74275ecf))
* **cli:** publish, list and share pages from the command line ([35a5664](https://github.com/andidev30/the-artifact/commit/35a5664a3bc867cc7614e8b7e0c699f471f1a7ba))
* comments on pages, readable by agents over MCP ([891f9c9](https://github.com/andidev30/the-artifact/commit/891f9c951913ee1ff8f50d9c9dd308f262a89ab4))
* delete, version history and zip download over MCP ([e7a2c8f](https://github.com/andidev30/the-artifact/commit/e7a2c8f1fbc1adc991a319b5790b3211be967679))
* **deploy:** add a Helm chart ([882998e](https://github.com/andidev30/the-artifact/commit/882998e0e81bea00d2cf2f44a4275ebeade59203)), closes [#38](https://github.com/andidev30/the-artifact/issues/38)
* **deploy:** Helm chart, published with each release ([3799f68](https://github.com/andidev30/the-artifact/commit/3799f68513e8c1fcb981580c3fba6fd7102be008))
* **deploy:** probe /healthz and /readyz, document scraping metrics ([ec2bbdd](https://github.com/andidev30/the-artifact/commit/ec2bbddfd5c4ba2b93f0fdf52f2675990d4adaed)), closes [#22](https://github.com/andidev30/the-artifact/issues/22)
* **deploy:** run the hosted service on Vercel with Supabase ([c4f36e8](https://github.com/andidev30/the-artifact/commit/c4f36e8e5e7663966eaa4266126c22af66054367))
* **deploy:** run the hosted service on Vercel with Supabase ([a27bf47](https://github.com/andidev30/the-artifact/commit/a27bf4796f8bda9b31b3a44139b368dfeca4fa43))
* **deploy:** run the published image in Docker Compose ([6998491](https://github.com/andidev30/the-artifact/commit/69984914aa93b6d2c0604746fec33eb4262ac8d3))
* **deploy:** run the published image in Docker Compose ([2d99df5](https://github.com/andidev30/the-artifact/commit/2d99df5285ddbd7b3d7a3d3ed30c9d58cb524bbc)), closes [#10](https://github.com/andidev30/the-artifact/issues/10)
* **ee:** enforce the Personal plan's page and history limits ([eedf309](https://github.com/andidev30/the-artifact/commit/eedf309361e05f42ffbea399d06fae1873b7c552))
* **ee:** enforce the Personal plan's page and history limits ([7e60b66](https://github.com/andidev30/the-artifact/commit/7e60b66e3b31ce6406535753c8d948c6ea118c66))
* **ee:** open the free Personal cloud plan ([00c7d66](https://github.com/andidev30/the-artifact/commit/00c7d66d8810fb6f06f081590ebd08ff1863607d))
* **ee:** open the free Personal cloud plan ([0f56467](https://github.com/andidev30/the-artifact/commit/0f5646710db17d8d58d30e39773c34e7d1e217bb))
* **ee:** set the Organization plan to $4 per member / month ([81347fb](https://github.com/andidev30/the-artifact/commit/81347fb66f8c3d7b7a3266233f2bc82e7d900111))
* **ee:** set the Organization plan to $4 per member / month ([f10cf45](https://github.com/andidev30/the-artifact/commit/f10cf45604b42d948f42db02c94a60191926441a))
* gallery search, folders and pagination ([5b106ad](https://github.com/andidev30/the-artifact/commit/5b106add5b6e9bca78b7659e7f9e7aee431fec87))
* health checks, JSON request logs and Prometheus metrics ([85f5f84](https://github.com/andidev30/the-artifact/commit/85f5f844e325389d9744b25f6bf6327482630e6d))
* passkeys, two-factor sign-in and active sessions ([dd8558e](https://github.com/andidev30/the-artifact/commit/dd8558e5acbb88d3f8d77a394571b38c6b2f0b88))
* **web:** comments panel in the page viewer and new-comment counts on cards ([dcea278](https://github.com/andidev30/the-artifact/commit/dcea27876c27b9247b3fe1c3c7867490f409fedb))
* **web:** download a page as a zip from its menu ([5b0256c](https://github.com/andidev30/the-artifact/commit/5b0256c13a53b7a6cca3f0962247629b36d6fc4f))
* **web:** embed code in the share dialog ([0f24125](https://github.com/andidev30/the-artifact/commit/0f241255d655c950d4bcac0690ad462c7da3b753)), closes [#42](https://github.com/andidev30/the-artifact/issues/42)
* **web:** gallery folders and infinite scroll ([97154aa](https://github.com/andidev30/the-artifact/commit/97154aadc8c9e6b4f6a705ebc43ab6a717dbea50))
* **web:** manage access tokens in account and organization settings ([20594f0](https://github.com/andidev30/the-artifact/commit/20594f03de1f1530539e303dd751d8243dbb50c5)), closes [#32](https://github.com/andidev30/the-artifact/issues/32)
* **web:** passkeys, two-factor sign-in and sessions in settings ([7c74298](https://github.com/andidev30/the-artifact/commit/7c742987643dfdb8d613289a10e5b82d822c8f56)), closes [#41](https://github.com/andidev30/the-artifact/issues/41)


### Bug fixes

* **deploy:** leave Helm chart passwords unset instead of empty ([5ee84d8](https://github.com/andidev30/the-artifact/commit/5ee84d8de9afd5164ca129d2e3021742baf68aa7))
* **web:** accessibility audit ([acfa76e](https://github.com/andidev30/the-artifact/commit/acfa76e80f30344b94f9aac2c601a2d60d3218b8))
* **web:** keyboard use and focus handling across the app ([4ded4b2](https://github.com/andidev30/the-artifact/commit/4ded4b2b3fd2c42c2e75314181e52846d867bb80))
* **web:** tie form errors to their fields and raise placeholder contrast ([30138af](https://github.com/andidev30/the-artifact/commit/30138af4273647390db509a518759195abc9e966))


### Performance

* **web:** lazy-load Admin, Settings, organization settings and Docs ([59039c8](https://github.com/andidev30/the-artifact/commit/59039c8e15801cf423f64880df5ae28bbdf16ed4))
* **web:** lazy-load Admin, Settings, organization settings and Docs ([13d3fb7](https://github.com/andidev30/the-artifact/commit/13d3fb7441b1dc3f292dae13679e1acabbe06de1))

## [0.1.0](https://github.com/andidev30/the-artifact/releases/tag/v0.1.0) (2026-09-27)

First release: hosting for the HTML pages coding agents publish over MCP.

### Features

* MCP server with tools to publish, list, read, rename, share and change access to pages, with OAuth 2.1 sign-in for MCP clients
* Single-file and multi-file pages served in a sandboxed frame, with version history and restore
* Sharing by email as viewer or editor, organization-wide or by link
* Organizations with owners, admins and members, and invitations
* Gallery thumbnails rendered in headless Chromium
* Server admin area: people, organizations and the sign-up policy
* Runs with or without SMTP
* Image `ghcr.io/andidev30/the-artifact:0.1.0` for linux/amd64 and linux/arm64
