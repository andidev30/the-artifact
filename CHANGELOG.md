# Changelog

Every release of The Artifact, newest first. Entries are generated from the commit messages when a release is made; what you have to do when you upgrade is in [Upgrading](docs/upgrading.md), and the versioning policy is there too.

## [0.6.1](https://github.com/andidev30/the-artifact/compare/v0.6.0...v0.6.1) (2026-09-28)


### Bug fixes

* **ops:** start Hosted migrate over REST, which the fine-grained token allows ([ceb7fe1](https://github.com/andidev30/the-artifact/commit/ceb7fe104dd500fe6d23505b9a49157a70602db1))

## [0.6.0](https://github.com/andidev30/the-artifact/compare/v0.5.0...v0.6.0) (2026-09-28)


### Features

* **api:** compare two versions of a page and diff_versions for agents ([ce0104b](https://github.com/andidev30/the-artifact/commit/ce0104be505f1fd395812b57f9839a9c9e5cf86a))
* **api:** inspect_artifact lets agents check a page before sharing it ([9e3b1a3](https://github.com/andidev30/the-artifact/commit/9e3b1a33c20ea069dad8ff4d4d9e51543e0571a4))
* **api:** inspect_artifact lets agents check a page before sharing it ([ec534c7](https://github.com/andidev30/the-artifact/commit/ec534c7b450edaaca39bd304188ac5bf63edb656)), closes [#137](https://github.com/andidev30/the-artifact/issues/137)
* **api:** update some files of a page without republishing all of it ([150a9c4](https://github.com/andidev30/the-artifact/commit/150a9c460d0bc3e1b8fc6839f7c0e4896aefbcdd))
* **cli:** publish --only and --remove to update some files of a page ([eeb61ca](https://github.com/andidev30/the-artifact/commit/eeb61ca847d83414de6c7f9b73422388ad7f79fe))
* **cli:** publish --watch publishes a new version whenever files change ([4ee03a4](https://github.com/andidev30/the-artifact/commit/4ee03a4bac247fad026a3a90d04647ed7eaedb5d))
* compare two versions of a page ([cde769d](https://github.com/andidev30/the-artifact/commit/cde769d97e7338afa7032a58b4a9cb97c81e7275))
* duplicate a page, or move it to another workspace ([8fb4f34](https://github.com/andidev30/the-artifact/commit/8fb4f3423d50895cf7698308630c7c0fd25b105c))
* duplicate a page, or move it to another workspace ([7e764df](https://github.com/andidev30/the-artifact/commit/7e764dffcf889fb568e88ffd4b9b7bda90286191)), closes [#140](https://github.com/andidev30/the-artifact/issues/140)
* export all data of an account or organization ([f8f3973](https://github.com/andidev30/the-artifact/commit/f8f3973b32d173616d07ef54376439a4b1343790))
* export all data of an account or organization ([c98972b](https://github.com/andidev30/the-artifact/commit/c98972ba67fadce2dec28a38717949d1fed727b0)), closes [#144](https://github.com/andidev30/the-artifact/issues/144)
* pin comments to an element of the page ([aee5f6b](https://github.com/andidev30/the-artifact/commit/aee5f6bd15de90d05e85743c3bffb5e958301214))
* pin comments to an element of the page ([3d697e0](https://github.com/andidev30/the-artifact/commit/3d697e0cd04071f1d453ec9a13ab80ad9a468c1a)), closes [#142](https://github.com/andidev30/the-artifact/issues/142)
* publish --watch with live updates in the viewer ([a40d1be](https://github.com/andidev30/the-artifact/commit/a40d1bebd921ad9f4b8eab0abb3d11464a50102a))
* tags on pages, and search inside page content ([99cf7cc](https://github.com/andidev30/the-artifact/commit/99cf7cc5344f27b3cc900104f19fb0cef973baec)), closes [#145](https://github.com/andidev30/the-artifact/issues/145)
* update one file of a page without republishing all of it ([8939c76](https://github.com/andidev30/the-artifact/commit/8939c76fa28014719fa15886cc3dcb8c6b8a09d9))
* **web:** compare two versions from the history, side by side or as changes ([51aa9d5](https://github.com/andidev30/the-artifact/commit/51aa9d508930db7a6948b3b4302cced4c35f1771))
* webhooks with Slack and Discord formats ([cca476f](https://github.com/andidev30/the-artifact/commit/cca476f66b40017f2143b04316aad8bc97b4fcee))
* webhooks, tags and search inside pages (includes [#155](https://github.com/andidev30/the-artifact/issues/155)) ([5e16c7c](https://github.com/andidev30/the-artifact/commit/5e16c7c7bead28665af0436bdf05822a297c5a61))
* **web:** show new versions of an open page without a reload ([97dc00f](https://github.com/andidev30/the-artifact/commit/97dc00f8d64fe5ff5e351e98e49c0b43644939a2))


### Bug fixes

* **api:** keep the server running when a webhook round fails ([69f8a18](https://github.com/andidev30/the-artifact/commit/69f8a183dea29bdd0b19d95e524d764e4daca8af))
* **api:** say only "No page you can edit" when an update targets such a page ([e4e3d67](https://github.com/andidev30/the-artifact/commit/e4e3d67595e885150746144c3437fa9ef35c12dd))
* **web:** keep the compare controls in the main landmark and name the version pickers by their labels only ([2bb7255](https://github.com/andidev30/the-artifact/commit/2bb7255d9b5c73e64a9fd573cc0d4c2f77e47387))

## [0.5.0](https://github.com/andidev30/the-artifact/compare/v0.4.1...v0.5.0) (2026-09-28)


### Bug fixes

* accept only same-origin paths after sign-in ([0bc2804](https://github.com/andidev30/the-artifact/commit/0bc2804d7e1d203f2787cbb1e83e7ac93ac9b979))
* **api:** accept only plain email addresses and send mail to one mailbox ([beeb1a5](https://github.com/andidev30/the-artifact/commit/beeb1a595fb14dd576e3a49a14cfad230c914a62))
* **api:** answer 404 for malformed page ids and version numbers ([5c87998](https://github.com/andidev30/the-artifact/commit/5c87998bcf61714c7cb17fc3e2be1e1c210c1530))
* **api:** check membership and two-factor sign-in on every agent request, revoke a refresh token family on reuse ([a2ad6d2](https://github.com/andidev30/the-artifact/commit/a2ad6d299c6e7e19422e38b7f82466ba1188427b))
* **api:** check the request's origin on state-changing requests ([ae7de7e](https://github.com/andidev30/the-artifact/commit/ae7de7e98e20e7f771d6bbd40db84eb588462ad6))
* **api:** count wrong passwords and codes before checking them ([d708015](https://github.com/andidev30/the-artifact/commit/d708015990451d0b6b89c49309f955a418d00ea2))
* **api:** don't reveal whether content is already stored for someone else ([a6166d7](https://github.com/andidev30/the-artifact/commit/a6166d79411f1545825049c86e03eeba9d8648d6))
* **api:** join by invitation link only for addresses nobody checked ([6945491](https://github.com/andidev30/the-artifact/commit/69454912b0e765e5df8256f05f555d57a7996b9b))
* **api:** limit a SCIM token to its organization ([863669c](https://github.com/andidev30/the-artifact/commit/863669caabaff4b09d43f875e5bc922951925731))
* **api:** log unexpected errors in the JSON format without query parameters ([9cf0adb](https://github.com/andidev30/the-artifact/commit/9cf0adbefae0f2f3eff61073e3c877b0d5300aa4))
* **api:** misc hardening: upload shortcuts, invitations without email, error logs, control characters ([62ad024](https://github.com/andidev30/the-artifact/commit/62ad0247952aabf0d1139f05e3bf4e6acee7db9d))
* **api:** refuse control characters in titles and names ([46b3850](https://github.com/andidev30/the-artifact/commit/46b38505a0d23b14d4518821bcede26fff1b3cf3))
* **api:** scope SCIM tokens and recheck agent tokens and content links ([b56976b](https://github.com/andidev30/the-artifact/commit/b56976bb0c7107c91d46f329b85db3c9a03440af))
* **api:** tighten agent redirect addresses and keep emails out of a log line ([c70dc02](https://github.com/andidev30/the-artifact/commit/c70dc02545b3fcba0f9afdc51065aa9cf31a193b))
* **api:** treat IPv4-compatible and reserved IPv6 ranges as not public for screenshots ([9d095fc](https://github.com/andidev30/the-artifact/commit/9d095fc75d240e7ac9db72a5502f743aa3bb0400))
* ask for a fresh sign-in before adding a first password ([837e443](https://github.com/andidev30/the-artifact/commit/837e443144d56f4d055fe73f42b98bbe51556d7e))
* **deploy:** wait for the real Postgres server, not the one that initialises it ([de355c3](https://github.com/andidev30/the-artifact/commit/de355c3d38051f95da8af4c056fbc9bcae6ae787))
* **deploy:** wait for the real Postgres server, not the one that initialises it ([9ddccc6](https://github.com/andidev30/the-artifact/commit/9ddccc6e501333a22d0dfd95c24ac35b645f30dc))
* harden sign-in redirects, request origins and attempt limits ([6245056](https://github.com/andidev30/the-artifact/commit/6245056ad36eb3b3a926856e31af4d97c03e226e))
* response hardening (malformed ids, nosniff, self-hosted fonts, email addresses, robots.txt) ([7f81f1b](https://github.com/andidev30/the-artifact/commit/7f81f1b2f9cd38a42624d5f06cf312998c331920))
* send nosniff on every response and serve robots.txt ([b0a3b04](https://github.com/andidev30/the-artifact/commit/b0a3b04ee40cd718b5f07a194eb6dc0b1377f998))
* **web:** self-host the web fonts ([8dd4b46](https://github.com/andidev30/the-artifact/commit/8dd4b46328b49825aa09edeeff027620bb63acc8))


### Performance

* **api:** batch view counts in memory and write them every 5 seconds ([766cc3c](https://github.com/andidev30/the-artifact/commit/766cc3c166099ab6e666f0c76521f1b25ff4ee45))
* **api:** batch view counts in memory and write them every 5 seconds ([3d78cea](https://github.com/andidev30/the-artifact/commit/3d78cea2ea107d23ebb429e188769fb864f0653e)), closes [#122](https://github.com/andidev30/the-artifact/issues/122)
* **api:** check, decode and hash large inline publishes on worker threads ([2b434ce](https://github.com/andidev30/the-artifact/commit/2b434ce85bd7892c1d2bd76dd8b15dbeb760c917)), closes [#121](https://github.com/andidev30/the-artifact/issues/121)
* **api:** give S3 the blob's hash instead of hashing it again ([331a616](https://github.com/andidev30/the-artifact/commit/331a6168ee1e401b89b794bd0323a91b6d5b5164)), closes [#121](https://github.com/andidev30/the-artifact/issues/121)
* **api:** keep large inline publishes off the main thread ([64b95e6](https://github.com/andidev30/the-artifact/commit/64b95e6ab0625e57e2104530ec20f039354ed88e))
* **api:** parse MCP request bodies once ([459ab96](https://github.com/andidev30/the-artifact/commit/459ab96888be0944d23208cb2563898b82858be1)), closes [#121](https://github.com/andidev30/the-artifact/issues/121)
* **api:** render THUMBNAIL_CONCURRENCY thumbnails at a time ([44968a8](https://github.com/andidev30/the-artifact/commit/44968a8cfa4cde29627323c1ab0b9d2df89ebe9c))
* **api:** render THUMBNAIL_CONCURRENCY thumbnails at a time ([616ec6a](https://github.com/andidev30/the-artifact/commit/616ec6ac28a181691444ef3ec07e9ec0d2b3e136)), closes [#120](https://github.com/andidev30/the-artifact/issues/120)
* **api:** run one worker process per CPU with node:cluster ([cd4e671](https://github.com/andidev30/the-artifact/commit/cd4e6715a963b802101cff17b6ba0228b12b3186))
* **api:** run one worker process per CPU with node:cluster ([93014d5](https://github.com/andidev30/the-artifact/commit/93014d5ca52335e066d5440f6e58b3be21d12b75)), closes [#118](https://github.com/andidev30/the-artifact/issues/118)
* **api:** serve page files with one query when warm ([ebda495](https://github.com/andidev30/the-artifact/commit/ebda495c0310578c2de38fce977f0e51d907ecaf))
* **api:** serve page files with one query when warm ([a91200b](https://github.com/andidev30/the-artifact/commit/a91200b6b714d50df009623fa88e7de71a115b06)), closes [#119](https://github.com/andidev30/the-artifact/issues/119)


### Documentation

* complete the upgrade notes for 0.5.0 ([e76e6a3](https://github.com/andidev30/the-artifact/commit/e76e6a3c2aae561b3edaa129315aedbe0a49e124))

## [0.4.1](https://github.com/andidev30/the-artifact/compare/v0.4.0...v0.4.1) (2026-09-28)


### Bug fixes

* **web:** keep long values and headers inside the screen on phones ([8d20b3b](https://github.com/andidev30/the-artifact/commit/8d20b3bc0e41798a6addf826837facc430880953))

## [0.4.0](https://github.com/andidev30/the-artifact/compare/v0.3.0...v0.4.0) (2026-09-28)


### Features

* **cli:** use the hosted service when no server is given ([5b416b5](https://github.com/andidev30/the-artifact/commit/5b416b5a3596cb2d85d9db058d822d9d0eb5c3ac))
* sample pages, linked from the README and the landing page ([3f5a9f1](https://github.com/andidev30/the-artifact/commit/3f5a9f132f9ce2181f1539d180d06a73bd7d129f))
* sample pages, linked from the README and the landing page ([795213c](https://github.com/andidev30/the-artifact/commit/795213cfc943fd28c6e97f341b8b0d638dbaef94))


### Bug fixes

* send addresses that end in a slash to the API on Vercel ([a33444e](https://github.com/andidev30/the-artifact/commit/a33444e90ff91a0d0160680a9f9129259f15c94c))
* send addresses that end in a slash to the API on Vercel ([46c5011](https://github.com/andidev30/the-artifact/commit/46c5011d998ab65ecc3368b27cda43a055970bd6))
* **web:** docs' Pricing link lands on pricing; feat(cli): hosted service by default ([031a876](https://github.com/andidev30/the-artifact/commit/031a8768f99a01c38f2d7a2aab065ee96794ce58))
* **web:** the docs' Pricing link lands on the pricing section ([8594da2](https://github.com/andidev30/the-artifact/commit/8594da2dcc0be8acec865d1e3e1f24c54587fb53))
* **web:** tidy the share dialog's link options and add a Never choice for link expiry ([62d73fd](https://github.com/andidev30/the-artifact/commit/62d73fd22485597535c07027e0118eb3e34d1d6a))
* **web:** tidy the share dialog's link options and add a Never choice for link expiry ([90eac44](https://github.com/andidev30/the-artifact/commit/90eac44aecc78fe1c70641f0da55accf1705085e))

## [0.3.0](https://github.com/andidev30/the-artifact/compare/v0.2.0...v0.3.0) (2026-09-28)


### Features

* **api:** count page views and record who opened a page ([47f007f](https://github.com/andidev30/the-artifact/commit/47f007fb8097b18288a9858fc94d1e5d431f12cf))
* **api:** SAML connections for single sign-on, and SCIM provisioning ([b92e228](https://github.com/andidev30/the-artifact/commit/b92e228abbcc99f84a77b382e36342b5a21615b5))
* **api:** trust the hosted service's first license signing key ([3f7781f](https://github.com/andidev30/the-artifact/commit/3f7781fd5c570a15103fe9711436ca6daf548082))
* **api:** trust the hosted service's first license signing key ([d416d15](https://github.com/andidev30/the-artifact/commit/d416d1544afc130b295e2ba0d2edce87f7fd4677))
* **api:** verify license keys offline and gate enterprise features on them ([c91cea0](https://github.com/andidev30/the-artifact/commit/c91cea0403cc61c75ee3110cd57e89eb399e9cab))
* **ee:** audit log for organizations ([061bbff](https://github.com/andidev30/the-artifact/commit/061bbffb831a5c56b514da55b9cafb3ad1ad805d))
* **ee:** audit log for organizations ([1374f07](https://github.com/andidev30/the-artifact/commit/1374f07afa0cd086089f53eebe75017912060733))
* **ee:** record the hosted service's sign-up funnel and show it in Server admin ([d509a8d](https://github.com/andidev30/the-artifact/commit/d509a8d35358755098db2ab2e4b53dd8f5201f36)), closes [#50](https://github.com/andidev30/the-artifact/issues/50)
* **ee:** sign-up funnel for the hosted service ([fcd8d55](https://github.com/andidev30/the-artifact/commit/fcd8d55062b3975f1353be2f12bb4c4f7a040ca0))
* **ee:** stop offering new organizations on the hosted service until billing ([8b36c28](https://github.com/andidev30/the-artifact/commit/8b36c28cb281713111b4d986d0719f25d613f425))
* **ee:** stop offering new organizations on the hosted service until billing ([0762ba9](https://github.com/andidev30/the-artifact/commit/0762ba9942eef9da223a2bcf4bda80bfd33b1e3a))
* **ee:** terms of service, privacy policy, sub-processors and a DPA ([e48887c](https://github.com/andidev30/the-artifact/commit/e48887c3923bfc5490726394d05b350b9559d940))
* **ee:** terms of service, privacy policy, sub-processors and a DPA ([d95cfa9](https://github.com/andidev30/the-artifact/commit/d95cfa9a14fd3583b07e68887b0a4486d69ed055))
* **ee:** Vercel analytics on the hosted service only, without secrets in addresses ([b56db21](https://github.com/andidev30/the-artifact/commit/b56db21b919aa1e730c06a0a96ce96c38cf79612))
* license keys for self-hosted installs ([1a3e60d](https://github.com/andidev30/the-artifact/commit/1a3e60d390c66f04de53cc999c81a731eca6199a))
* link sharing that expires, needs a password, or is reset with a new key ([8d73823](https://github.com/andidev30/the-artifact/commit/8d738234cb07ac47beed40dd68d645b3d079ed91))
* link sharing that expires, needs a password, or is reset with a new key ([819e3d9](https://github.com/andidev30/the-artifact/commit/819e3d9a0acb99c21af59fdc8f689a91039b31eb))
* SAML single sign-on and SCIM provisioning (Enterprise) ([36634cb](https://github.com/andidev30/the-artifact/commit/36634cb529d05f8eaa08d2bc157abea8c380af14))
* serve pages from a separate content domain with CONTENT_ORIGIN ([d769db1](https://github.com/andidev30/the-artifact/commit/d769db1ce92581035f94010b22bf15503a3c5d58))
* serve pages from a separate content domain with CONTENT_ORIGIN ([06811c8](https://github.com/andidev30/the-artifact/commit/06811c8e73a849739d70bc948ca8cd9e2d60ff3f)), closes [#40](https://github.com/andidev30/the-artifact/issues/40)
* single sign-on with OpenID Connect (Enterprise) ([35ddeab](https://github.com/andidev30/the-artifact/commit/35ddeabc1c55429edd15addf0666894b5b0c6708))
* single sign-on with OpenID Connect for licensed self-hosted installs ([b276e1c](https://github.com/andidev30/the-artifact/commit/b276e1c5ee4e8138d4e6d42e558f3cbfab97fe8e))
* tell self-hosted admins about new releases ([a2b2fb9](https://github.com/andidev30/the-artifact/commit/a2b2fb9f5355aee5a11256b45f2be3d1b307fe61))
* tell self-hosted admins about new releases ([27cbb85](https://github.com/andidev30/the-artifact/commit/27cbb85d8455a0ea8215b83a8c4e92f399b567bd)), closes [#39](https://github.com/andidev30/the-artifact/issues/39)
* version retention per organization (Enterprise) ([d741f7b](https://github.com/andidev30/the-artifact/commit/d741f7b6261e2f04c1226749daac0566c0bb5187))
* version retention per organization as an enterprise feature ([d786fc4](https://github.com/andidev30/the-artifact/commit/d786fc40bcb5938ab591ca5840dc1b3367749a1a))
* view counts and who opened a page ([fc092a1](https://github.com/andidev30/the-artifact/commit/fc092a140003e4b707a870e29e701b6728953c27))
* **web:** enter a license key in Server admin, and issue keys on the hosted service ([e4f8a19](https://github.com/andidev30/the-artifact/commit/e4f8a191e8a7ecbe97e71eccaada6b97599ed81c))
* **web:** SAML providers in Single sign-on, and SCIM tokens in Server admin ([94aa347](https://github.com/andidev30/the-artifact/commit/94aa347c62484d21bdb9f3eeceb1a85715427d07))
* **web:** show a page's views and who opened it in the viewer ([a7d6232](https://github.com/andidev30/the-artifact/commit/a7d62326b45e7d4a3d67f69f48a4d819f37fd240))


### Bug fixes

* **api:** sign upload links without a checksum of the empty body ([80364ff](https://github.com/andidev30/the-artifact/commit/80364ff9c835eae14dd5d314593c0352b4abb490))
* **api:** sign upload links without a checksum of the empty body ([9f1a9bd](https://github.com/andidev30/the-artifact/commit/9f1a9bdcbd4ba230caa635a0df4d2d6385a5920d))
* refuse vbscript: OAuth redirects and strip nested tags from heading ids ([3042bca](https://github.com/andidev30/the-artifact/commit/3042bca20991bb08e3096412c570974230137ec8))
* refuse vbscript: OAuth redirects and strip nested tags from heading ids ([c668667](https://github.com/andidev30/the-artifact/commit/c6686673482a9fc43b761668b11710742f3100c0))
* **web:** give the views count its own class and label versions on their own ([9811041](https://github.com/andidev30/the-artifact/commit/9811041c87539a01485380f82b1ae3bf6451f6e3))
* **web:** keep the SSO test result through a remounted effect, and open e2e pages in their own context ([a85d0e2](https://github.com/andidev30/the-artifact/commit/a85d0e2fd42b3975e6e50801cfb96cf47b83c71f))

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
