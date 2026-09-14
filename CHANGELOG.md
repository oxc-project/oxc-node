# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.1.2](https://github.com/oxc-project/oxc-node/compare/v0.1.1...v0.1.2) (2026-09-14)

### Bug Fixes

* handle Windows UNC file URLs ([#744](https://github.com/oxc-project/oxc-node/issues/744)) ([#760](https://github.com/oxc-project/oxc-node/issues/760)) ([116cbcd](https://github.com/oxc-project/oxc-node/commit/116cbcd86a4a96ecb9362634f30db57f451b09ad)), closes [hash#name](https://github.com/hash/issues/name) [#46](https://github.com/oxc-project/oxc-node/issues/46)


## [0.1.1](https://github.com/oxc-project/oxc-node/compare/v0.1.0...v0.1.1) (2026-09-13)

### Bug Fixes

- emit ESM imports for injected helpers in ES modules ([#743](https://github.com/oxc-project/oxc-node/issues/743)) ([bf94957](https://github.com/oxc-project/oxc-node/commit/bf94957186987339af9be8d78da5d7e264779116)), closes [#742](https://github.com/oxc-project/oxc-node/issues/742)
- honour useDefineForClassFields instead of inverting it ([#742](https://github.com/oxc-project/oxc-node/issues/742)) ([9a4c088](https://github.com/oxc-project/oxc-node/commit/9a4c08870f2eecbb086d0b433cbd5ec874bccd77)), closes [#743](https://github.com/oxc-project/oxc-node/issues/743)
- resolve JSON modules with oxc-node's resolver ([#745](https://github.com/oxc-project/oxc-node/issues/745)) ([be799a4](https://github.com/oxc-project/oxc-node/commit/be799a4c71446601c801b03cd4678a9b9e5e6c2f)), closes [#726](https://github.com/oxc-project/oxc-node/issues/726) [#633](https://github.com/oxc-project/oxc-node/issues/633)
- run CommonJS-reported files with ESM syntax as ES modules ([#759](https://github.com/oxc-project/oxc-node/issues/759)) ([27bab1b](https://github.com/oxc-project/oxc-node/commit/27bab1bd22edb4aad268ad3ea40d69d204386eb2)), closes [#452](https://github.com/oxc-project/oxc-node/issues/452) [#569](https://github.com/oxc-project/oxc-node/issues/569) [#745](https://github.com/oxc-project/oxc-node/issues/745)

### Features

- discover the nearest tsconfig.json that claims each file ([#569](https://github.com/oxc-project/oxc-node/issues/569)) ([ec06c3c](https://github.com/oxc-project/oxc-node/commit/ec06c3cc5585ad177c466b4fbbdcd39e0878b782))

## [0.0.35](https://github.com/oxc-project/oxc-node/compare/v0.0.34...v0.0.35) (2025-12-01)

### Bug Fixes

- **core:** transform tla error ([#355](https://github.com/oxc-project/oxc-node/issues/355)) ([3374ad1](https://github.com/oxc-project/oxc-node/commit/3374ad1f1be9ecd86ac76ed990b65013102ed806))
- sourcemaps for pirates hook. ([#350](https://github.com/oxc-project/oxc-node/issues/350)) ([dc915e0](https://github.com/oxc-project/oxc-node/commit/dc915e0336eeb9b326caa1fbd5628b8156f61d92))

## [0.0.34](https://github.com/oxc-project/oxc-node/compare/v0.0.33...v0.0.34) (2025-11-09)

**Note:** Version bump only for package oxc-node

## [0.0.27](https://github.com/oxc-project/oxc-node/compare/v0.0.26...v0.0.27) (2025-05-03)

**Note:** Version bump only for package oxc-node

## [0.0.26](https://github.com/oxc-project/oxc-node/compare/v0.0.25...v0.0.26) (2025-05-03)

**Note:** Version bump only for package oxc-node

## [0.0.25](https://github.com/oxc-project/oxc-node/compare/v0.0.24...v0.0.25) (2025-05-02)

### Bug Fixes

- respect module option in tsconfig.json ([#116](https://github.com/oxc-project/oxc-node/issues/116)) ([4acd6a9](https://github.com/oxc-project/oxc-node/commit/4acd6a9577f1108c0dc7c371f3e3ac2b16f6b3d6))

## [0.0.24](https://github.com/oxc-project/oxc-node/compare/v0.0.23...v0.0.24) (2025-04-28)

### Bug Fixes

- sourcemap generation ([#105](https://github.com/oxc-project/oxc-node/issues/105)) ([b583e28](https://github.com/oxc-project/oxc-node/commit/b583e28af61901b8a4314644b4c0dbe217f83a6d))

### Performance Improvements

- remove with_scope_tree_child_ids workaround ([#104](https://github.com/oxc-project/oxc-node/issues/104)) ([d7df81e](https://github.com/oxc-project/oxc-node/commit/d7df81e7997bebd98f0d077f88a91390e65d1378))

## [0.0.23](https://github.com/oxc-project/oxc-node/compare/v0.0.22...v0.0.23) (2025-04-10)

### Bug Fixes

- **core:** pass resolved sources to nextResolve ([#96](https://github.com/oxc-project/oxc-node/issues/96)) ([3dd8faa](https://github.com/oxc-project/oxc-node/commit/3dd8faa8593968cf8585ec99d2f933db70419f97))
- **core:** resolve path in node_modules ([#94](https://github.com/oxc-project/oxc-node/issues/94)) ([f211208](https://github.com/oxc-project/oxc-node/commit/f2112082a18c6b07755f7f568967247ac0d57eb6))

### Features

- allow read useDefineForClassFields compiler option in tsconfig.json ([#97](https://github.com/oxc-project/oxc-node/issues/97)) ([55830b3](https://github.com/oxc-project/oxc-node/commit/55830b32bf8a9bb557ec7f0a32017c9f9a9ab1da))

## [0.0.22](https://github.com/oxc-project/oxc-node/compare/v0.0.21...v0.0.22) (2025-04-02)

### Bug Fixes

- **core:** pass tsconfig: None to Resolver if tsconfig not exists ([#84](https://github.com/oxc-project/oxc-node/issues/84)) ([9b46f48](https://github.com/oxc-project/oxc-node/commit/9b46f487e2d5775cb7b124ca1308733f720536f3))

### Features

- **core:** pass tsconfig options to oxc ([#92](https://github.com/oxc-project/oxc-node/issues/92)) ([2771453](https://github.com/oxc-project/oxc-node/commit/2771453654414ad1960f28ab89b5a90cbaf6b988))
- resolve cjs files ([#93](https://github.com/oxc-project/oxc-node/issues/93)) ([9ef439e](https://github.com/oxc-project/oxc-node/commit/9ef439e78ed11069f93629d756316ae377618e20))

## [0.0.21](https://github.com/oxc-project/oxc-node/compare/v0.0.20...v0.0.21) (2025-03-16)

**Note:** Version bump only for package oxc-node

## [0.0.20](https://github.com/oxc-project/oxc-node/compare/v0.0.19...v0.0.20) (2025-03-05)

**Note:** Version bump only for package oxc-node

## [0.0.19](https://github.com/oxc-project/oxc-node/compare/v0.0.18...v0.0.19) (2025-01-20)

**Note:** Version bump only for package oxc-node

## [0.0.18](https://github.com/oxc-project/oxc-node/compare/v0.0.17...v0.0.18) (2025-01-20)

### Bug Fixes

- **core:** enfore to esm if file extensions match ([#55](https://github.com/oxc-project/oxc-node/issues/55)) ([560ee7a](https://github.com/oxc-project/oxc-node/commit/560ee7a3e5c120a57b34fdba81e9e8f57b0826d1))

## [0.0.17](https://github.com/oxc-project/oxc-node/compare/v0.0.16...v0.0.17) (2025-01-13)

### Bug Fixes

- **core:** resolve entry with oxc_resolver ([#53](https://github.com/oxc-project/oxc-node/issues/53)) ([85af142](https://github.com/oxc-project/oxc-node/commit/85af1423129a582a72aea52de426f1f6cc5c091f))

## [0.0.16](https://github.com/oxc-project/oxc-node/compare/v0.0.15...v0.0.16) (2024-12-13)

**Note:** Version bump only for package oxc-node

## [0.0.14](https://github.com/oxc-project/oxc-node/compare/v0.0.12...v0.0.14) (2024-07-23)

**Note:** Version bump only for package oxc-node

## [0.0.13](https://github.com/oxc-project/oxc-node/compare/v0.0.12...v0.0.13) (2024-07-23)

**Note:** Version bump only for package oxc-node

## [0.0.12](https://github.com/oxc-project/oxc-node/compare/v0.0.11...v0.0.12) (2024-07-23)

### Features

- **cli:** init oxnode ([#23](https://github.com/oxc-project/oxc-node/issues/23)) ([8740e05](https://github.com/oxc-project/oxc-node/commit/8740e05a97c33b99042824b09c92390421c90c81))

## [0.0.11](https://github.com/oxc-project/oxc-node/compare/v0.0.10...v0.0.11) (2024-07-21)

### Bug Fixes

- **core:** wasi target ([#22](https://github.com/oxc-project/oxc-node/issues/22)) ([e7a57f3](https://github.com/oxc-project/oxc-node/commit/e7a57f334bce84f15b04f781b5ce7078d52a8872))

## [0.0.10](https://github.com/oxc-project/oxc-node/compare/v0.0.9...v0.0.10) (2024-07-18)

### Features

- support named import from json ([#20](https://github.com/oxc-project/oxc-node/issues/20)) ([622f1fa](https://github.com/oxc-project/oxc-node/commit/622f1fa880cd596057bf41ea44dca60951f80180))

## [0.0.9](https://github.com/Brooooooklyn/oxc-node/compare/v0.0.8...v0.0.9) (2024-07-17)

**Note:** Version bump only for package oxc-node

## [0.0.8](https://github.com/Brooooooklyn/oxc-node/compare/v0.0.7...v0.0.8) (2024-07-16)

### Features

- **core:** handle TypeScript resolveJsonModule option ([#12](https://github.com/Brooooooklyn/oxc-node/issues/12)) ([3b0d0a4](https://github.com/Brooooooklyn/oxc-node/commit/3b0d0a46072be64752b70cfaf4cfcdcab4617335))

### Performance Improvements

- **core:** skip transform files in node_modules ([#13](https://github.com/Brooooooklyn/oxc-node/issues/13)) ([0ed2c19](https://github.com/Brooooooklyn/oxc-node/commit/0ed2c1915902613968735aacc6c41a2ae7c77531))

## [0.0.6](https://github.com/Brooooooklyn/oxc-node/compare/v0.0.5...v0.0.6) (2024-07-13)

### Bug Fixes

- **core:** resolve .cjs/.cts file in esm pacakge ([#7](https://github.com/Brooooooklyn/oxc-node/issues/7)) ([9616417](https://github.com/Brooooooklyn/oxc-node/commit/9616417cb5c78ef3eae234b831c6aa425979f34b))
