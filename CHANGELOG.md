# Changelog

## [1.2.0](https://github.com/lsagetlethias/mmarchive/compare/v1.1.0...v1.2.0) (2026-09-02)


### Features

* **cli:** shell completion, structured output, and where to report a bug ([#32](https://github.com/lsagetlethias/mmarchive/issues/32)) ([5fa2b3b](https://github.com/lsagetlethias/mmarchive/commit/5fa2b3b8d00b005c40a45b2d024ba07d0f3584ee))
* **extractor:** anonymise a whole archive, and state what it does not cover ([#21](https://github.com/lsagetlethias/mmarchive/issues/21)) ([55b06aa](https://github.com/lsagetlethias/mmarchive/commit/55b06aae6dfce2d103e9396c377e4928061ae173))
* **extractor:** generate anonymisation pseudonyms, and scope the work around them ([#19](https://github.com/lsagetlethias/mmarchive/issues/19)) ([f697cd9](https://github.com/lsagetlethias/mmarchive/commit/f697cd92dd005b321a1ec9f6bf10ac2e72e9856d))
* **extractor:** replace clear-text names, behind three anonymisation levels ([#25](https://github.com/lsagetlethias/mmarchive/issues/25)) ([28e0842](https://github.com/lsagetlethias/mmarchive/commit/28e084294015cdfc3bdfc00c3e87ee32711c8424))
* **extractor:** report what the anonymisation left behind, without becoming the key ([#23](https://github.com/lsagetlethias/mmarchive/issues/23)) ([902609f](https://github.com/lsagetlethias/mmarchive/commit/902609ffa4e48dc663ac1d6daaeea0655dd14841))
* **extractor:** rewrite the anchored forms in both text surfaces ([#24](https://github.com/lsagetlethias/mmarchive/issues/24)) ([930cfaa](https://github.com/lsagetlethias/mmarchive/commit/930cfaabd1f8da393fec674d841812708c548598))
* **viewer:** complete from: and in: while typing ([#27](https://github.com/lsagetlethias/mmarchive/issues/27)) ([6dc37d6](https://github.com/lsagetlethias/mmarchive/commit/6dc37d67d51ccaf4bbbb4265438bc611f6030c68))


### Bug fixes

* **cli:** honour the exit codes and output streams the README promises ([#29](https://github.com/lsagetlethias/mmarchive/issues/29)) ([1feaf08](https://github.com/lsagetlethias/mmarchive/commit/1feaf08d4bb6092ab86c7e12ed363ec792c25e5e))
* **extractor:** stop claiming guarantees the code does not hold ([#28](https://github.com/lsagetlethias/mmarchive/issues/28)) ([279004d](https://github.com/lsagetlethias/mmarchive/commit/279004d99ee35430dd0b37db742d32edf8e3ae25))
* **extractor:** stop leaking identities the archive was meant to hide ([#22](https://github.com/lsagetlethias/mmarchive/issues/22)) ([62eaf9a](https://github.com/lsagetlethias/mmarchive/commit/62eaf9ad8322887a5babb4f550bcd4f302d6e612))


### Performance

* **viewer:** stop rebuilding the message list on every render ([#30](https://github.com/lsagetlethias/mmarchive/issues/30)) ([3db7821](https://github.com/lsagetlethias/mmarchive/commit/3db7821091d045d7b1dcd14a71609662f40f5850))

## [1.1.0](https://github.com/lsagetlethias/mmarchive/compare/v1.0.0...v1.1.0) (2026-08-30)


### Features

* **viewer:** add the lexical half of hybrid retrieval ([#15](https://github.com/lsagetlethias/mmarchive/issues/15)) ([8850533](https://github.com/lsagetlethias/mmarchive/commit/88505339cd1e8092aa4b7d13afd4a91f780da504))
* **viewer:** chunk the archive for retrieval, and measure it before sending anything ([#13](https://github.com/lsagetlethias/mmarchive/issues/13)) ([6d1ea16](https://github.com/lsagetlethias/mmarchive/commit/6d1ea16e290e204c147b3524f702216ba086653a))
* **viewer:** fuse the two halves of hybrid retrieval ([#16](https://github.com/lsagetlethias/mmarchive/issues/16)) ([cb4d058](https://github.com/lsagetlethias/mmarchive/commit/cb4d058232e6ae7cb8efca9ad8fb7f14f0ebad13))
* **viewer:** store the fragments, and refuse to serve stale ones ([#14](https://github.com/lsagetlethias/mmarchive/issues/14)) ([f353c66](https://github.com/lsagetlethias/mmarchive/commit/f353c668358b5cadadcafaa4bb1df74b6a592a89))


### Documentation

* scope the RAG against the real archive ([#11](https://github.com/lsagetlethias/mmarchive/issues/11)) ([8caf516](https://github.com/lsagetlethias/mmarchive/commit/8caf5167a01cbc205a5213432a416f2f45f466ba))
* write down how to decide, not just what remains undecided ([#17](https://github.com/lsagetlethias/mmarchive/issues/17)) ([cf60b90](https://github.com/lsagetlethias/mmarchive/commit/cf60b906292e2c8ff35385a663949ccb877fad6d))

## [1.0.0](https://github.com/lsagetlethias/mmarchive/compare/v0.2.1...v1.0.0) (2026-08-27)


### Documentation

* spell out what the search autocompletion would take ([#9](https://github.com/lsagetlethias/mmarchive/issues/9)) ([fb1f23f](https://github.com/lsagetlethias/mmarchive/commit/fb1f23ffd25fe9b1e6c84b7358db84b5b6a09e53))

## [0.2.1](https://github.com/lsagetlethias/mmarchive/compare/v0.2.0...v0.2.1) (2026-08-27)


### Documentation

* correct the ghcr visibility claim, and silence the index healthcheck ([#6](https://github.com/lsagetlethias/mmarchive/issues/6)) ([ecdee18](https://github.com/lsagetlethias/mmarchive/commit/ecdee18d7ee678fc6b4ad83c1e6190ba63c1aa87))
* make todo.md say what was decided, and record the RAG scope ([#8](https://github.com/lsagetlethias/mmarchive/issues/8)) ([3e7349b](https://github.com/lsagetlethias/mmarchive/commit/3e7349b966accce2122d8b88653554cde91c5fa5))

## [0.2.0](https://github.com/lsagetlethias/mmarchive/compare/v0.1.0...v0.2.0) (2026-08-27)


### Features

* **cli:** make every command safe to run outside a terminal ([9ad8535](https://github.com/lsagetlethias/mmarchive/commit/9ad8535db2276a3664cc7eb3d3263ac70291ff80))
* close the block 1 debt and ship the viewer deployment ([#2](https://github.com/lsagetlethias/mmarchive/issues/2)) ([d448091](https://github.com/lsagetlethias/mmarchive/commit/d448091dea6c5f1a4d29074dbbfdf439d20475fe))
* **extractor:** verify the archive at the end of every run ([c8719e8](https://github.com/lsagetlethias/mmarchive/commit/c8719e80b90b2505a3eea193c875f8e9a21b8ece))
* **viewer:** read an archive offline, from index builder to standalone copy ([#1](https://github.com/lsagetlethias/mmarchive/issues/1)) ([349ae42](https://github.com/lsagetlethias/mmarchive/commit/349ae42817ecbdf254b6b106ee372d8f168ba4a8))


### Bug fixes

* **ci:** stop Biome and release-please fighting over the manifest ([#5](https://github.com/lsagetlethias/mmarchive/issues/5)) ([865e338](https://github.com/lsagetlethias/mmarchive/commit/865e338f6f782b46c626fa95b4423b916265cc76))
* **extractor:** make redact actually erase data, and add its tests ([8b763b7](https://github.com/lsagetlethias/mmarchive/commit/8b763b73eb5f3c9b937c98b4d1f1207359908052))
* **extractor:** stop resume from destroying an already finalised channel ([b15e3d1](https://github.com/lsagetlethias/mmarchive/commit/b15e3d1e27a62ae27ec75f54ab242dee44213221))


### Documentation

* write a handoff for the viewer work ([4e5f458](https://github.com/lsagetlethias/mmarchive/commit/4e5f4580c82d999982e403395245b89c323a2f7f))


### Other changes

* **deps:** switch to Biome, pnpm 11, Node 24 and conventional commits ([955aaa4](https://github.com/lsagetlethias/mmarchive/commit/955aaa42b6bba635cc3e2b30ab4d878420447e35))
