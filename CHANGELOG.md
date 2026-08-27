# Changelog

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
