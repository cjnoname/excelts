# Changelog

## [0.7.0](https://github.com/documonster/documonster/compare/v0.6.0...v0.7.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* **excel:** `createCsvReadStream` emits `Uint8Array` chunks instead of `string`. Building a string by `+=`-ing chunks now breaks silently (`"" + new Uint8Array([97])` is `"97"`); decode with a streaming `TextDecoder`, or use `writeCsv()`. `Workbook.toBuffer` is declared `Promise<Buffer>` on Node and `Workbook.toStream` returns `XlsxReadable & Readable` there — both are narrowings, so existing code keeps compiling. See MIGRATION.md.
* **excel:** `Cell` functions take `"A1"` or `(row, col)`, never a mix — `Cell.getValue(ws, "A1", 99)` and `Cell.getValue(ws, 5)` no longer compile (both were already wrong at runtime). `Worksheet.columns()` returns deeply read-only `ColumnView`s, so writing to a column record no longer compiles; use `setColumns` / `Column.set*`. The OOXML enums are constant objects, so the numeric-enum reverse mapping (`ValueType[2]`) is gone and the types are literal unions rather than `number`. Eleven unreferenced type declarations were removed and four types renamed at their declaration; §8.7 and §8.8 of the migration guide map every case.

### Features

* **excel:** Export the public type surface and unify cell addressing ([2c6b17d](https://github.com/documonster/documonster/commit/2c6b17dde91b4d20920b714c78d2cab43e4e1761))
* **excel:** Make the IO types match the streams Node actually returns ([e80c214](https://github.com/documonster/documonster/commit/e80c2147b2c0362a0183014fe3631515bd4fe473))
* **stream:** Accept iterables and generator stages in pipeline ([3237f0c](https://github.com/documonster/documonster/commit/3237f0cb76a1daf873590331e200a0eea05605c3))


### Bug Fixes

* **build:** Make IIFE bundles byte-reproducible ([44a274d](https://github.com/documonster/documonster/commit/44a274d95ff57e55378de35defa408a034605a5c))
* **build:** Point browser declarations at the browser variants ([149170a](https://github.com/documonster/documonster/commit/149170a5d1d9ca9a5082f4935e5ef46826ae3667))
* **excel:** Keep the conditional-format number format on re-save ([3cd39e1](https://github.com/documonster/documonster/commit/3cd39e1173b3dd2e3f0d42f5f80646f5e9280eda))

## [0.6.0](https://github.com/documonster/documonster/compare/v0.5.1...v0.6.0) (2026-08-11)


### Features

* **excel:** Serialize a workbook as a pull source with Workbook.toStream ([128eea0](https://github.com/documonster/documonster/commit/128eea000c9630a5d8684294a9ee5b202655db05))


### Bug Fixes

* **archive:** Clear consumed async-queue slots ([d6765ca](https://github.com/documonster/documonster/commit/d6765caccbc2a39dd0dc931a6f4cfc9fdb58ac29))
* **archive:** Pause TAR input while gzip is backpressured ([2e558b0](https://github.com/documonster/documonster/commit/2e558b00f4eeb8685fdbbb67a3779fa38c339754))
* **archive:** Propagate ZIP output backpressure to input producers ([83a0324](https://github.com/documonster/documonster/commit/83a0324bcacc468964c384ca2bfea3b5f2e629ba))
* **csv:** Resume chunk rows after readable backpressure ([a084674](https://github.com/documonster/documonster/commit/a0846746cb14ddb983e29a9bdb551a6bfc26c769))
* **excel:** Honour backpressure for buffered ZIP parts ([3cf2d28](https://github.com/documonster/documonster/commit/3cf2d289f7bf531235014baf09924fe69ec59393))
* **excel:** Sample sink backpressure after an entry's output is emitted ([63589cb](https://github.com/documonster/documonster/commit/63589cb584b9e5e8adc5d5bd4273dcff3f4a6e79))
* **excel:** Wait for WorkbookWriter ZIP output before sampling drain ([56cebaa](https://github.com/documonster/documonster/commit/56cebaa0dffea574f214e7f9632fc10dadafc335))
* **stream:** Make async sink writes obey the writable contract ([4c5aa01](https://github.com/documonster/documonster/commit/4c5aa0132eb358df606fd38e505f6cacfbf256c6))
* **word:** Make addAsync wait for compressed sink output ([f69bc2a](https://github.com/documonster/documonster/commit/f69bc2a6b7156e67a2b46ee7b3ec5fffe1fe07a6))


### Code Refactoring

* **archive:** Restore queue O(n) dequeue and document output contracts ([e41bdb3](https://github.com/documonster/documonster/commit/e41bdb331c718967f20fc0e45a74b99fac971b2a))

## [0.5.1](https://github.com/documonster/documonster/compare/v0.5.0...v0.5.1) (2026-08-08)


### Bug Fixes

* **excel:** Stop reads from mutating the workbook ([ef6c876](https://github.com/documonster/documonster/commit/ef6c8762562a7d92055902abae2179e02c6c6357))
* **pdf:** Render inherited and out-of-dimension cell styles ([0433235](https://github.com/documonster/documonster/commit/0433235569fb740a1bfc2f4e08b04e1ac56c5607))
* **release:** Update canary version format to include 'sha' prefix ([d6b9392](https://github.com/documonster/documonster/commit/d6b93927af40212130239310c4fc5c991f841408))


### Code Refactoring

* **excel:** Export the cell style inheritance helper ([8461477](https://github.com/documonster/documonster/commit/846147715168bf732434b461ee2457ce8d45ab73))

## [0.5.0](https://github.com/documonster/documonster/compare/v0.4.0...v0.5.0) (2026-08-08)


### Features

* **excel:** Read a rectangular range with Range.getValues ([c672c76](https://github.com/documonster/documonster/commit/c672c767cfe96361921b4c6464c71b823b293327)), closes [#198](https://github.com/documonster/documonster/issues/198)

## [0.4.0](https://github.com/documonster/documonster/compare/v0.3.0...v0.4.0) (2026-08-03)


### Features

* **pdf:** Render Excel headers and footers on export ([5bbff48](https://github.com/documonster/documonster/commit/5bbff48a893f9ecef649df61f4793acb12ee3d4d))


### Bug Fixes

* **excel:** Preserve table and worksheet filter criteria on save ([e77b88b](https://github.com/documonster/documonster/commit/e77b88bcf908610ee0cf6229a52acbdbb916ff18))
* **formula:** Stabilize GEOMEAN across runtimes ([d8b9828](https://github.com/documonster/documonster/commit/d8b9828cd637684a38469d5f37df0fd100e634d2))
* **pdf:** Preserve Unicode Type3 text runs ([6edb2ab](https://github.com/documonster/documonster/commit/6edb2ab808b5fd33936c78883d8e6ae7e5c7be99))

## [0.3.0](https://github.com/documonster/documonster/compare/v0.2.0...v0.3.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* **formula:** isolate calculation behind snapshot plans

### Bug Fixes

* **excel:** Expose formula recalculation via documonster/excel/formula ([233625e](https://github.com/documonster/documonster/commit/233625e9ba595c5ec2b4b29669992c28e656536a)), closes [#193](https://github.com/documonster/documonster/issues/193)


### Code Refactoring

* **excel:** Streamline chart and formula planning ([6f314fa](https://github.com/documonster/documonster/commit/6f314fa5aae60a297580140d42f490b44c1b2f25))
* **formula:** Isolate calculation behind snapshot plans ([1c90316](https://github.com/documonster/documonster/commit/1c9031681577ff7e3f39bc2f456d226832eb0646))

## [0.2.0](https://github.com/documonster/documonster/compare/v0.1.2...v0.2.0) (2026-07-23)


### Features

* **excel:** Apply data validation to a whole column or range via DataValidation.add ([004fc57](https://github.com/documonster/documonster/commit/004fc57bffa880b791dfb1d9ef20dd9eabd28ba0)), closes [#191](https://github.com/documonster/documonster/issues/191)

## [0.1.2](https://github.com/documonster/documonster/compare/v0.1.1...v0.1.2) (2026-07-19)


### Bug Fixes

* **excel:** Invalid XML on write, importSheet aliasing, picture/group corruption, template content-types ([5d83cbd](https://github.com/documonster/documonster/commit/5d83cbd002ac381c78092bd06a6d90b38c5a22db))

## [0.1.1](https://github.com/documonster/documonster/compare/v0.1.0...v0.1.1) (2026-07-08)


### Bug Fixes

* **excel:** Export named-cell-style API from the browser Workbook surface ([ce05e83](https://github.com/documonster/documonster/commit/ce05e836c2578a0c0bd79a8cd21b3cbd09e43e0a))

## [0.1.0](https://github.com/documonster/documonster/compare/v0.0.3...v0.1.0) (2026-07-06)


### Features

* **excel:** Support named cell styles (Heading 1, Title, …) ([0ee5723](https://github.com/documonster/documonster/commit/0ee57235229bf22501e68e424bb4ccd3465e05b9))

## [0.0.3](https://github.com/documonster/documonster/compare/v0.0.2...v0.0.3) (2026-07-01)


### Code Refactoring

* **tests:** Update memory usage assertions in WorkbookWriter tests ([a928835](https://github.com/documonster/documonster/commit/a928835e68cafcb9ce436a694a761dc1f0a30ea5))

## [0.0.2](https://github.com/documonster/documonster/compare/v0.0.1...v0.0.2) (2026-07-01)


### Bug Fixes

* Inline prototype-pollution guards at merge/clone sinks ([7ba699c](https://github.com/documonster/documonster/commit/7ba699cb2aec4c7f604a7cc7471e775680e0d4a8))


### Code Refactoring

* Consolidate prototype-pollution key guards into shared helpers ([a39af0c](https://github.com/documonster/documonster/commit/a39af0caadad3980b0bcc54a13bce8d3ded9d7a7))

## [0.0.1](https://github.com/documonster/documonster/compare/v0.0.1...v0.0.1) (2026-07-01)


### Bug Fixes

* Inline prototype-pollution guards at merge/clone sinks ([7ba699c](https://github.com/documonster/documonster/commit/7ba699cb2aec4c7f604a7cc7471e775680e0d4a8))


### Code Refactoring

* Consolidate prototype-pollution key guards into shared helpers ([a39af0c](https://github.com/documonster/documonster/commit/a39af0caadad3980b0bcc54a13bce8d3ded9d7a7))

## 0.0.1 (2026-07-01)


### ⚠ BREAKING CHANGES

* **word:** markdownToDocx and markdownToDocxBody are now async; markdownToDocxBody returns MarkdownBodyResult instead of BodyContent[].
* pdf(), readPdf(), and excelToPdf() now return Promise instead of synchronous results. All call sites must use await.
* All Md-prefixed identifiers renamed to Markdown.
* **excel:** Deprecated type alias `ZipOptions` removed — use `WorkbookZipOptions` instead.
* Module structure and entry points have been reorganized. The archive, CSV, and stream submodules are now first-class exports. See MIGRATION.md for details.

### Features

* Add ./xml subpath export and treeshake verification ([6dfee7a](https://github.com/documonster/documonster/commit/6dfee7aaa84b076d275be50db8a4c356fc46c634))
* Add annotation/form creation, SVG path, digital signatures; extract shared crypto ([12f1a7b](https://github.com/documonster/documonster/commit/12f1a7bc5a50d2e0bd5fa355c9e6d5e4498ba560))
* Add generateTestCertificate() API; remove raw DER bytes from example ([e09f2c7](https://github.com/documonster/documonster/commit/e09f2c7100bb3d1738df6997d52b266cff9b8e95))
* Add high-level sign() API to PdfDocumentBuilder and PdfEditor ([5b61561](https://github.com/documonster/documonster/commit/5b615616590220b72042e74b0b665065554c00d4))
* Add minimumReleaseAgeExclude for TypeScript native preview versions ([dd90a9f](https://github.com/documonster/documonster/commit/dd90a9f040ce2043e21020184f7be13c3d1be3e9))
* Add PDF builder and editor APIs with unified image/text utilities ([e7e4709](https://github.com/documonster/documonster/commit/e7e47091b09414fa076eb009328f914ed44ae1ab))
* Add support for glossary (Building Blocks) and OLE embedded objects ([19beef5](https://github.com/documonster/documonster/commit/19beef51eeefa2993153c0588da017f6bb07e824))
* Add watermark support for PDF and Excel ([a0d72ec](https://github.com/documonster/documonster/commit/a0d72ec81246259b2182270ed234aa78763be53e)), closes [#134](https://github.com/documonster/documonster/issues/134)
* **archive:** Export binary/encoding utilities for standalone usage ([9d31a75](https://github.com/documonster/documonster/commit/9d31a75f9901438f526abf5e62b7166081ea1016))
* **chart:** Add ChartEx cache population for improved preview rendering ([cc3b389](https://github.com/documonster/documonster/commit/cc3b3899ea5a632d78a2f2d0ed1d6f995da5975f))
* Complete PDF builder, editor, and reader roadmap ([7572e0b](https://github.com/documonster/documonster/commit/7572e0b3964ecea5eee8f042e24615c4251df608))
* Complete pivot table implementation with roundtrip support and codebase refactoring ([2801053](https://github.com/documonster/documonster/commit/2801053450c369bfaeb6a14701cb08a01ed156a7))
* Enhance stream API with improved typing and error handling ([53cf027](https://github.com/documonster/documonster/commit/53cf02751febcf6abf9528b7f10227191370619f))
* Enhance Transform and Writable streams for better backpressure handling and error management ([4773dd8](https://github.com/documonster/documonster/commit/4773dd80a4454587666d8341afad4b668498b88c))
* Enhance unit conversion tests and improve twip calculations ([8b2be79](https://github.com/documonster/documonster/commit/8b2be79c5b2334adde16956a69ce3ee441159c5c))
* **excel:** Add autoFitColumns() and autoFitRows() for auto-sizing ([c209bdf](https://github.com/documonster/documonster/commit/c209bdfff0a7a6e947368fe9e2adaabc2687eec8)), closes [#114](https://github.com/documonster/documonster/issues/114)
* **excel:** Add Cell.displayText getter, export format helpers, fix date formatting bugs ([a9f4fb5](https://github.com/documonster/documonster/commit/a9f4fb5cd97c79accba6c2a5e65d0132a606ec93))
* **excel:** Add chart, chartEx, sparkline, and chartsheet support ([d13f95b](https://github.com/documonster/documonster/commit/d13f95b41146e21a5616612a1cdc239daadc87a5))
* **excel:** Add COUP family + BINOM.DIST.RANGE ([a7e3e54](https://github.com/documonster/documonster/commit/a7e3e54b19fcf6927cc85f74c04aa56ecfad7892))
* **excel:** Add Excel 365 dynamic array formula support (FILTER/SORT/UNIQUE/XLOOKUP/SEQUENCE) ([17e6c22](https://github.com/documonster/documonster/commit/17e6c22e9f3f394610f2705c06f666e025edcaed))
* **excel:** Add external workbook link support ([Book]Sheet!Ref) ([8d0d046](https://github.com/documonster/documonster/commit/8d0d0467658e32a609ca72e062fc8b216b0c6cae))
* **excel:** Add formula calculation engine with tokenizer, parser, evaluator, dependency graph, and 220+ Excel functions ([6b6c9a8](https://github.com/documonster/documonster/commit/6b6c9a84394becf658d4db3e2e1de17676197aeb))
* **excel:** Add ignoredErrors support, absoluteAnchor images, and reconcilePicture null guard ([da34761](https://github.com/documonster/documonster/commit/da3476107efe52dd95bf91db3df8bb1b77ed17e3))
* **excel:** Add matrix + series math functions (MMULT, MDETERM, MINVERSE, MUNIT, SERIESSUM) ([ee6a094](https://github.com/documonster/documonster/commit/ee6a09499d4f1f269369e78875ae767d7a702b88))
* **excel:** Add REGEX, VALUETOTEXT, ARRAYTOTEXT, PERCENTRANK, PROB functions ([03913e5](https://github.com/documonster/documonster/commit/03913e52d41c9e9d4d38e2634486c34329bb9c01))
* **excel:** Add shapes, SVG images, configurable note size, nested column keys ([ad7c201](https://github.com/documonster/documonster/commit/ad7c201ee12f89574836304bb9445c1168709051))
* **excel:** Add SQRTPI, ENCODEURL, ACCRINTM, TBILL*, PRICEMAT, YIELDMAT ([96813b8](https://github.com/documonster/documonster/commit/96813b81a14ad2c413a8ffad171e38d949c015cf))
* **excel:** Add workbook structure protection and public defaultFont API ([7f15a58](https://github.com/documonster/documonster/commit/7f15a583aa4dcb2abda25b0152a561ca9ecc212b))
* **excel:** Cast-free hyperlink + formula+hyperlink cell input ([86340a0](https://github.com/documonster/documonster/commit/86340a0586846218447b869b457c3923fe194feb))
* **excel:** Chart compatibility matrix, docs & ChartEx/3D/dataTable/userShapes gaps ([3c31a9e](https://github.com/documonster/documonster/commit/3c31a9edb5d409234620d47167854972271fc45f))
* **excel:** Chart integration test suite + removeChart anchor cleanup ([465fa6e](https://github.com/documonster/documonster/commit/465fa6ea48ffb7192e764f3b5e2721fda832b958))
* **excel:** Classic-chart schema validator + dLbls child order + pivot anchor ([5f6a37c](https://github.com/documonster/documonster/commit/5f6a37c306ba0c2080620b6632619a69b08fb083))
* **excel:** Harden formula engine — +5000 tests, 30+ bug fixes, 34 new functions, 3D ref + dynamic-array dependency fixes ([06b0cf4](https://github.com/documonster/documonster/commit/06b0cf462e936f4646313467cdf5af089d2a7c0f))
* **excel:** Lazy chart support + test infrastructure improvements ([6b5a24d](https://github.com/documonster/documonster/commit/6b5a24d55a7ab883ee8784960750e52ce1aff861))
* **excel:** OOXML validator overhaul + chart compliance fixes + full chart catalogue ([3638020](https://github.com/documonster/documonster/commit/363802034aefa3f0fe99cc87a58d5e820e01a61e))
* **excel:** Support external (linked) images ([#170](https://github.com/documonster/documonster/issues/170)) ([#171](https://github.com/documonster/documonster/issues/171)) ([c89822c](https://github.com/documonster/documonster/commit/c89822c256416b5ffe207c34307398030467c72b))
* Excelts v6 — cross-platform streaming, archive, and CSV ([28d4f5a](https://github.com/documonster/documonster/commit/28d4f5ab129f57977d3d9fe6b0bfa90e6dcce560))
* Expose isEncrypted on UnzipEntry in streaming mode ([bd03cf5](https://github.com/documonster/documonster/commit/bd03cf56b48e121629e69b8ee8aeff83f2dfe1ae))
* **formula:** Comprehensive Excel compliance overhaul + 4 architectural features ([2fcf19d](https://github.com/documonster/documonster/commit/2fcf19dcc78a2a7e9313e4ab86a6790a6863fda4))
* Initial documonster release setup ([5390730](https://github.com/documonster/documonster/commit/539073004e24c861ebb230316f28cf7b9de04460))
* Integrate sheet-utils into native Worksheet/Workbook API ([34148b1](https://github.com/documonster/documonster/commit/34148b1d85d21d2a1d08f428669c6fe3842c2c1a))
* **issue-templates:** Add "Formula" and "Utils" options to module dropdowns ([71f4c32](https://github.com/documonster/documonster/commit/71f4c32cd3d671006612a0b3d733cea7c447eee5))
* Make PDF APIs async to avoid blocking the event loop ([2f521cd](https://github.com/documonster/documonster/commit/2f521cd3c7706c191f01e9483ebff659c963c73d))
* **md:** Add Markdown table module with GFM parsing, formatting, and Workbook integration ([dfd55b7](https://github.com/documonster/documonster/commit/dfd55b77594fd3c1c4e7332aee3b4bbc1090433a))
* **pdf:** Add ignorePrintArea option to export full used range ([2c38381](https://github.com/documonster/documonster/commit/2c3838167dc5fc95b76004635be00a335b5cd13b))
* **pdf:** Add image embedding support for standalone pdf() and excelToPdf() ([9d0f2b2](https://github.com/documonster/documonster/commit/9d0f2b2c0c472684b5a40d8817931b7e8d6c11a4))
* **pdf:** Add zero-dependency Excel-to-PDF export module ([fdc568b](https://github.com/documonster/documonster/commit/fdc568be0a2d14d5d3df5a7d00d2124c5273c421))
* **pdf:** Add zero-dependency PDF reader with text, image, and metadata extraction ([23663b3](https://github.com/documonster/documonster/commit/23663b3337392c5fc098cc4b15ee6243f6879ff2))
* **pdf:** Upgrade writer to PDF 2.0/AES-256, add annotation and form field extraction ([c725147](https://github.com/documonster/documonster/commit/c725147efd803ea28d34fe0aaf8210cfbd11ee0f))
* **stream:** Add Symbol.hasInstance, static isDisturbed, pause/resume events, _construct/_undestroy, writev, and addListener/removeListener aliases ([8de5efe](https://github.com/documonster/documonster/commit/8de5efe7cbff9c54edd3d8498e77397a40e385d4))
* **stream:** Add WorksheetWriter.addImage support ([#108](https://github.com/documonster/documonster/issues/108)) ([a91d9e1](https://github.com/documonster/documonster/commit/a91d9e11b8304037658b9bbfc169bde497fd2521))
* **stream:** Enhance Duplex and Readable implementations for better compatibility and performance ([60badc1](https://github.com/documonster/documonster/commit/60badc1a147468500341b0a67c5d32c8ed8489b9))
* **stream:** Enhance stream functionality with new tests, utility functions, and improved options handling ([123ffcf](https://github.com/documonster/documonster/commit/123ffcfce0dbbc34b343480d120599fed3fae829))
* **word, pdf:** Complete the layout pipeline and harden 13 round-trip / streaming gaps ([bc5b67f](https://github.com/documonster/documonster/commit/bc5b67f73a15cdf59f37da998256f891cd506826))
* **word,pdf:** Complete header/footer margins, ChartEx and table fidelity in conversions ([187ce4d](https://github.com/documonster/documonster/commit/187ce4d379044c67c04cb9f2c599cd70081e6489))
* **word:** Add comprehensive Word (DOCX) processing module ([b3d09e9](https://github.com/documonster/documonster/commit/b3d09e9b810dbb825c4c3144b8e54bb3176c8a69))
* **word:** Add footnote and endnote references in document body ([2d1887b](https://github.com/documonster/documonster/commit/2d1887b76da80cadf14bf95945ff63bfdd3839ea))
* **word:** Add hyperlink styling for visited and unvisited links ([ee61c87](https://github.com/documonster/documonster/commit/ee61c87601e8bb763a517baec9f02ff670a9b4bf))
* **word:** Consolidate and harden the word module ([895541e](https://github.com/documonster/documonster/commit/895541e80cbc2cfcc2ea271e60aad0b403ea362c))
* **word:** Embed images and footnotes in markdown-to-docx conversion ([9ec00a6](https://github.com/documonster/documonster/commit/9ec00a6f8a8eacf785f17101101517278ed3c5c5))
* **word:** Enhance checkbox handling and table styling with row/column band sizes ([df18bbd](https://github.com/documonster/documonster/commit/df18bbd7b3a87cd5841b34e772c4e10d9c322308))
* **word:** Enhance diff algorithm to pair similar paragraphs as modified based on text similarity ([89da4d4](https://github.com/documonster/documonster/commit/89da4d423b261ac7c65d466629a6a3b2985d0532))
* **word:** Enhance glossary handling with self-contained sub-documents and strict gallery validation ([d82b397](https://github.com/documonster/documonster/commit/d82b397d7ec93ffeb8b8b9f6a2b4921214c0beb0))
* **word:** Enhance watermark functionality with custom dimensions and improved rendering ([b780dbb](https://github.com/documonster/documonster/commit/b780dbb2b488f8dc5f7c590f976a74f482b971a5))
* **word:** Implement page break stripping to prevent trailing blank pages in split documents ([050bd1c](https://github.com/documonster/documonster/commit/050bd1c7d1780b4c19c611a216887d84250ca65f))
* **word:** Improve section break handling in document merge and split operations ([2b621e7](https://github.com/documonster/documonster/commit/2b621e72d9f1a80af99ea02a66fd4d3bb05939eb))
* **word:** Split word-complete example into 47 focused examples ([fd0d3eb](https://github.com/documonster/documonster/commit/fd0d3eb6ee6216dd5530c98bfebe734e107e5291))
* **xml:** Add ignoreAttributes option and remove fast-xml-parser references ([3ae7f67](https://github.com/documonster/documonster/commit/3ae7f675f0c7749ca49f404471528983eaf96a6a))
* **xml:** Add invalidCharHandling option for tolerant XML parsing ([f4c5ecc](https://github.com/documonster/documonster/commit/f4c5ecc5eb82becbe58da0909f3fc0d9556da5e9))
* **xml:** Add isArray callback for per-tag array wrapping in toPlainObject/parseXmlToObject ([edd69c3](https://github.com/documonster/documonster/commit/edd69c3a5d92810483733692626c64ffdd4070b3))
* **xml:** Add standalone [@xml](https://github.com/xml) module with streaming write pipeline and backpressure support ([a0a0630](https://github.com/documonster/documonster/commit/a0a063031f00cb4c8837b7cb47a37ca8a28c7b8c))
* **xml:** Add toPlainObject and parseXmlToObject for XML-to-plain-object conversion ([b7275dc](https://github.com/documonster/documonster/commit/b7275dc0215b4c2d507adbc1d4efb208213c4cbf))


### Bug Fixes

* Add main, module, and types fields to package.json for legacy moduleResolution compatibility ([3f67511](https://github.com/documonster/documonster/commit/3f67511325b183a0752debaebca223b6cbe99d67)), closes [#69](https://github.com/documonster/documonster/issues/69)
* Add PDF subpath export and complete tree-shake coverage for all modules ([4faedf6](https://github.com/documonster/documonster/commit/4faedf6949471e9412113e33605553a5e4a93189))
* Add post-publish verification step to CI workflows ([c93c9c4](https://github.com/documonster/documonster/commit/c93c9c4b10600821fd6689533e89fbd06b005f3e))
* **archive:** Drastically improve compression ratio for streaming writes ([78f9f22](https://github.com/documonster/documonster/commit/78f9f22cbe75be144b7fae53a66c5c706ae35762))
* **archive:** Stabilize flaky ZipCrypto wrong password test ([75cfc53](https://github.com/documonster/documonster/commit/75cfc53bea7dec8f16d0ceec49b04a526859444e))
* **archive:** Use Dynamic Huffman and native CompressionStream for browser compression ([b18414d](https://github.com/documonster/documonster/commit/b18414d38d5f2cfaed5daa80aa50899157624aa8)), closes [#125](https://github.com/documonster/documonster/issues/125)
* Avoid file system race condition in XML stream writer example ([#77](https://github.com/documonster/documonster/issues/77)) ([7a83866](https://github.com/documonster/documonster/commit/7a8386694da3e347fce8ec200cce5db860ecae15))
* **build:** Prevent race condition on dist/types during parallel builds ([d0db0dc](https://github.com/documonster/documonster/commit/d0db0dc36dd950df8e7281ca0200c5387837aadb))
* Chai assertion syntax, anchor copy-paste bug, duplicate test, and 8 weak assertions ([4919a36](https://github.com/documonster/documonster/commit/4919a3613317709cfafbcacdce184aafec80008c))
* Change Worksheet.columns return type from Column[] | null to Column[] ([ab3f3fe](https://github.com/documonster/documonster/commit/ab3f3fef022d8f6d081fdc064bf3a1a38a0ef121))
* **chart:** Correct documentation, rendering, and cross-workbook copy issues ([3039fec](https://github.com/documonster/documonster/commit/3039fecede48115fe261dda03788b878a1f64d1f))
* **ci:** Avoid npm preversion hook in canary version bump ([3bcf30f](https://github.com/documonster/documonster/commit/3bcf30f7eb1eed7c8e8e63331d689c2101aa2113))
* **ci:** Match release-please merge commit message pattern ([4fedfd8](https://github.com/documonster/documonster/commit/4fedfd8d1d261c755fbd70d0084bc51709d6ec7e))
* **ci:** Point asset-size at dist/iife and drop dead benchmark script ([cfac76f](https://github.com/documonster/documonster/commit/cfac76ffef0540df13798172675263e121f5a1f4))
* **ci:** Remove stale release-as pinning to unblock version bumps ([1da5585](https://github.com/documonster/documonster/commit/1da558575de7a1e79de16f48e07e6bf1b6bf6961))
* **ci:** Resolve merge conflict, keep quoted if expression ([f909a62](https://github.com/documonster/documonster/commit/f909a6210703fb7573add9f5a45e14b6e4864134))
* **ci:** Update chart-oracle test paths after refactor ([71b23bc](https://github.com/documonster/documonster/commit/71b23bc96469bf42eeb6be6cc9d6940ee2458de5))
* Clone images when duplicating rows ([#57](https://github.com/documonster/documonster/issues/57)) ([bd7d949](https://github.com/documonster/documonster/commit/bd7d949694641f2968a94424f14123827c5634c3))
* Consolidate module links, remove duplicate sections from READMEs ([4a85b2c](https://github.com/documonster/documonster/commit/4a85b2c8a2f1183cac7882a90955cab4d660e859))
* Consume data descriptor after known-size pump in streaming parser ([f7be681](https://github.com/documonster/documonster/commit/f7be68135e55fc62d82240166fe18f53673d86dd))
* Correct dishonest type tightenings and remove unsafe toJSON generic ([d974843](https://github.com/documonster/documonster/commit/d9748433666b2b0870098fe2900901aa8cde7245))
* Correct rotated text alignment and add slanted borders in PDF rendering ([10b2d8c](https://github.com/documonster/documonster/commit/10b2d8c2ffc5ce271a37e9a962cfef2d4686a068))
* **csv:** Comprehensive audit fixes across parse, format, stream, and worker modules ([c664dd9](https://github.com/documonster/documonster/commit/c664dd99ad0c6ecd0ea3555b647c01ef1d6542b7))
* **csv:** Guard all prototype-pollution keys in worker aggregation ([51bcc3f](https://github.com/documonster/documonster/commit/51bcc3f7b2253871d65d45fb624db37a3268ec6a))
* Data bar CF ext section in streaming writer, add WorksheetWriter.addRows() ([ea47ced](https://github.com/documonster/documonster/commit/ea47ced479679861e03f70f3a11790058e20bc80))
* Decode OOXML _xHHHH_ escapes in table column name attributes ([#94](https://github.com/documonster/documonster/issues/94)) ([bbfe148](https://github.com/documonster/documonster/commit/bbfe1484799d21ed477cdaad3d7d23e4a1404e50))
* Decode OOXML _xHHHH_ escapes with lowercase hex digits ([#94](https://github.com/documonster/documonster/issues/94)) ([9c3163f](https://github.com/documonster/documonster/commit/9c3163fef636f6b600f133fdb1a9f94aa35617cc))
* **duplex:** Change Transform import to type-only import ([13efb04](https://github.com/documonster/documonster/commit/13efb046b13f551009c3dba4de8fe439510c86ce))
* Empty style object shadowing in _mergeStyle and shared style references in row/cell operations ([7df419d](https://github.com/documonster/documonster/commit/7df419daeac85c743c4ae50c885025c7b69bcee6))
* Enhance backpressure handling in StreamingZipWriterAdapter for sync and async write() return types ([156b5fa](https://github.com/documonster/documonster/commit/156b5fa95d6bcae158b2f6020183350a61c2de8d))
* **excel:** Bind worksheets robustly and reject pseudo-key ids ([#166](https://github.com/documonster/documonster/issues/166)) ([8158a0c](https://github.com/documonster/documonster/commit/8158a0c366a3ad87185a20903da967dfed2ac2cb))
* **excel:** Case-insensitive worksheet name lookup and correct internal hyperlink OOXML output ([2e5f0dc](https://github.com/documonster/documonster/commit/2e5f0dc1641e7aee3af7ae916432d2bb202cd58a))
* **excel:** Change WorkbookWriter default compression level from 1 to 6 ([d30313a](https://github.com/documonster/documonster/commit/d30313a05ab401072df094dbd02881bb96330c1e))
* **excel:** Eleven chart bugs surfaced by a review + TZ-independent date serial ([0f240e0](https://github.com/documonster/documonster/commit/0f240e0b1960dc86029c9010207d5b06b5234c4d))
* **excel:** External links cause Excel to reject file as corrupt ([eeaa273](https://github.com/documonster/documonster/commit/eeaa273bf0d87b7817faeab1da57af260bebae4f))
* **excel:** Fix 21 formula engine bugs, add 13 functions, 2 language features ([487079a](https://github.com/documonster/documonster/commit/487079a2136f8f84e4e4b0a6e7edfbfe1e727293))
* **excel:** Fix data validation sort, empty border truthy, and table name uniqueness ([59f24cf](https://github.com/documonster/documonster/commit/59f24cfa4dd840e40c97fb672b029a798daa224c))
* **excel:** Make worksheet name lookup case-insensitive to match Excel semantics ([f735884](https://github.com/documonster/documonster/commit/f73588411a102b913d9fdc971124b835b17a69ea))
* **excel:** Preserve formula+hyperlink and rich-text on round-trip ([#142](https://github.com/documonster/documonster/issues/142)) ([fa350f7](https://github.com/documonster/documonster/commit/fa350f7ffc18deacad5088311e033c846b4a1606))
* **excel:** Read legacy comment body written as a bare &lt;t&gt; run ([d802cba](https://github.com/documonster/documonster/commit/d802cba9cc8203b27a80c987587181c794b6e5fd)), closes [#173](https://github.com/documonster/documonster/issues/173)
* **excel:** Replace pseudo-glyph PNG text rendering with real TTF rasterizer ([3adefdb](https://github.com/documonster/documonster/commit/3adefdb85bf36ce012b6517cdd0932e4d47c2c2d))
* **excel:** SUBTOTAL/AGGREGATE full Excel semantics, totals-row SUBTOTAL codes, multi-area mask merging ([128c54c](https://github.com/documonster/documonster/commit/128c54cf4f4ae84d422ec1b2677b27ce30b62ad4))
* **excel:** Support comments subdirectory layout and author round-trip ([#148](https://github.com/documonster/documonster/issues/148)) ([480d108](https://github.com/documonster/documonster/commit/480d108c9296bafa45148b80a8085ac853478f23))
* **excel:** Support multiple print areas and normalise print references ([#168](https://github.com/documonster/documonster/issues/168)) ([faabb36](https://github.com/documonster/documonster/commit/faabb36d02708c7d42ead12c2b303ae3b28ab019))
* **excel:** Support range operator ':' with dynamic refs, add 50+ functions, fix SUBTOTAL/AGGREGATE semantics ([f912857](https://github.com/documonster/documonster/commit/f9128570091d0bd6ab566a528f923c27657e5763))
* Extract _checkBackpressure to resolve CodeQL missing-await alerts [#74](https://github.com/documonster/documonster/issues/74) [#75](https://github.com/documonster/documonster/issues/75) [#76](https://github.com/documonster/documonster/issues/76) ([7081e1f](https://github.com/documonster/documonster/commit/7081e1f0ec46c3e6a933d0feb9b418e6f8a61010))
* **formula:** Correct merged-cell handling in aggregates and dynamic-array spills ([8359737](https://github.com/documonster/documonster/commit/8359737db47de7d41c3eeb15724c84e04226bd5d))
* Handle async write() return in StreamingZipWriterAdapter backpressure check ([dc8c3fd](https://github.com/documonster/documonster/commit/dc8c3fd317134bf099650e306103152ff3b90a71))
* Handle empty defined name ranges and missing colon in print area/titles ([74ce4e6](https://github.com/documonster/documonster/commit/74ce4e6a7bc711c334580bc9cb603800c9b07888))
* Hide internal underscore-prefixed members from public type declarations ([f94d157](https://github.com/documonster/documonster/commit/f94d1579a2c964e4b4d42269e560d3642f1e06cb)), closes [#68](https://github.com/documonster/documonster/issues/68)
* **html-import:** Remove unnecessary assignment in tokenizer function ([4f4832b](https://github.com/documonster/documonster/commit/4f4832b1d140ac0fce9fa4f13fa77bfbf323339a))
* Improve Excel-to-PDF style fidelity and fix cell style mutation leaks ([0448604](https://github.com/documonster/documonster/commit/044860403f6d5454f85b92fe701e2f7a13fbab73))
* Improve normalizeWritable function to handle Web WritableStream correctly ([f5cf6f5](https://github.com/documonster/documonster/commit/f5cf6f5fd5167004d90d7f12ae9bfb0ddb053c08))
* Improve public API return types and enum types ([d261785](https://github.com/documonster/documonster/commit/d261785d4ade30ad5db953a17286e309a0753193))
* Improve public API return types and enum types ([c8ca73c](https://github.com/documonster/documonster/commit/c8ca73c10da12fbe5c824e502938a4e6ab0e5017))
* IsDateFmt now correctly recognizes date formats with text fallback sections ([#79](https://github.com/documonster/documonster/issues/79)) ([2d5f238](https://github.com/documonster/documonster/commit/2d5f2389a8d7d145b34a92dc6c7ef7231be7beab))
* Make signature widget visible so Adobe Acrobat shows signature status ([d4cfcef](https://github.com/documonster/documonster/commit/d4cfcef5c911131a5795108d4251abe2f604dd78))
* Merge main fixes, resolve lint errors, and improve code quality ([8a33545](https://github.com/documonster/documonster/commit/8a335459b5acde8e4a8a25b3fcdfb2f382f3228e))
* MergeCells now preserves perimeter borders like Excel ([d9d28d6](https://github.com/documonster/documonster/commit/d9d28d66500b05665fab2399277ba2536b2a7d65))
* Move signature widget to invisible rect so visible text is not clickable ([4d2bc96](https://github.com/documonster/documonster/commit/4d2bc9690cf073b7c1f89ea4ea2ba20c9bab268a))
* **package:** Remove Word references from description, keywords, and exports ([d31d27f](https://github.com/documonster/documonster/commit/d31d27f1b130212e98dbb64c9bc9ac42e391ab49))
* **pdf:** Correct rich text font inheritance, indexed colors, and overflow borders ([8090686](https://github.com/documonster/documonster/commit/8090686e4f345e13bd4182472796faa4718fe536))
* **pdf:** Draw borders after overflow erase to prevent white rects from covering border lines ([2b8c997](https://github.com/documonster/documonster/commit/2b8c9974429d1f69127d76873c2e59a074470d1a))
* **pdf:** Overhaul chart rendering in PDF export ([72711e7](https://github.com/documonster/documonster/commit/72711e7b7c5b87e912a81568490f74d749db8406))
* **pdf:** Preserve non-WinAnsi text and improve DOCX→PDF flow fidelity ([5b34a35](https://github.com/documonster/documonster/commit/5b34a35c28b9c102f84af43b037632be85e0d94d))
* **pdf:** Prevent double-unescaping in XML entity decoding (CWE-116) ([4423033](https://github.com/documonster/documonster/commit/442303343894cc7686fb43b0b7bed88772ac8d62))
* **pdf:** Resolve rich text bold inheritance and border rendering issues ([#154](https://github.com/documonster/documonster/issues/154)) ([50be87e](https://github.com/documonster/documonster/commit/50be87e950869a00e6b62cc0b55ece34a416b053))
* **pdf:** Restore Excel-accurate border line widths ([#164](https://github.com/documonster/documonster/issues/164)) ([70978d7](https://github.com/documonster/documonster/commit/70978d74428651ea787d1ae522a6e72d8871dc3e))
* **pdf:** Rich text overflow, per-run wrap measurement, and overflow erase ([82faf0f](https://github.com/documonster/documonster/commit/82faf0f68ef8553dbd6853268de813dc7bd915ef))
* **pdf:** Stop reading every system font when a covering match is already found ([3e16c3c](https://github.com/documonster/documonster/commit/3e16c3cd6cb60ce028fe4173d79f4a07593de0a5))
* **pdf:** Unicode text rendering and long text clipping in PDF export ([#150](https://github.com/documonster/documonster/issues/150)) ([6b6aea9](https://github.com/documonster/documonster/commit/6b6aea94a6d51f2f41155a34f3627329d620e317))
* Preserve merge information when splicing rows/columns and duplicating rows ([#53](https://github.com/documonster/documonster/issues/53)) ([62bbc16](https://github.com/documonster/documonster/commit/62bbc160cfb76ed6686b4c81620feb4c3fc5c143))
* Preserve merged cell styles when splicing rows/columns ([#55](https://github.com/documonster/documonster/issues/55)) ([668bec7](https://github.com/documonster/documonster/commit/668bec7956818fd6d30b57993d6c74b9b3f213a6))
* Prevent image duplication on read-write round-trips ([#58](https://github.com/documonster/documonster/issues/58)) ([3da3461](https://github.com/documonster/documonster/commit/3da3461c68bd751e2b43527e458e4ee847b5a9b4))
* Prevent unbounded memory growth in StreamBuf when data listeners are attached ([090b2e4](https://github.com/documonster/documonster/commit/090b2e42b659f251f2409cbf7691939f0fb7e9a0))
* Promote to 6.0.0 stable release ([083e0e0](https://github.com/documonster/documonster/commit/083e0e0be35f49ff866223b569e30d8ca288f115))
* Radio button Annots, signature digest algorithm, editor radio overlay ([1d2d785](https://github.com/documonster/documonster/commit/1d2d785979be1a5ba58b68cc48edb2ec32e985b9))
* Rename zip export to archive in package.json ([f5b3efb](https://github.com/documonster/documonster/commit/f5b3efbbe9cc57f2999fe9aff5eab8db6f1d5359))
* Resolve all 19 CodeQL security alerts ([8e7a79a](https://github.com/documonster/documonster/commit/8e7a79a96e220775ecb2e4b7497fc9d761b03be2))
* Resolve CI failures on Node.js 22 and Windows ([83bd891](https://github.com/documonster/documonster/commit/83bd891d4e85d77adfd9bed9f6b2efd222956b38))
* Resolve CodeQL [#80](https://github.com/documonster/documonster/issues/80) [#82](https://github.com/documonster/documonster/issues/82) — isolate PDF key derivation from shared crypto ([ef2347c](https://github.com/documonster/documonster/commit/ef2347cb6db1656797b1cb1f869b8186c80a9d81))
* Resolve CodeQL security alerts [#79](https://github.com/documonster/documonster/issues/79), [#80](https://github.com/documonster/documonster/issues/80), [#81](https://github.com/documonster/documonster/issues/81) ([b35777c](https://github.com/documonster/documonster/commit/b35777c33213f6bf42289c713071300dd5a891fa))
* Resolve CodeQL security alerts [#80](https://github.com/documonster/documonster/issues/80) [#82](https://github.com/documonster/documonster/issues/82) — exclude PDF-mandated hashes ([b99bd23](https://github.com/documonster/documonster/commit/b99bd23deba0d1325036f1ad68234ded79b2de24))
* Resolve last 4 CodeQL alerts with inline barriers ([fa727e4](https://github.com/documonster/documonster/commit/fa727e4aa68d4346d42bb420a7f45a2fb35445af))
* Resolve PDF border overlap and text-border collision ([#136](https://github.com/documonster/documonster/issues/136)) ([6ce6c2c](https://github.com/documonster/documonster/commit/6ce6c2cb9012a940f5017fa33cb1c3cff314cbde))
* Resolve remaining 13 CodeQL security alerts ([91e6628](https://github.com/documonster/documonster/commit/91e6628b6f2286abcc3144cd56768705842cb2b7))
* Resolve TypeError when loading workbook with table column child elements ([f4bcbe6](https://github.com/documonster/documonster/commit/f4bcbe63921060984762fb48f2aa07f5446962a7)), closes [#76](https://github.com/documonster/documonster/issues/76)
* Resolve Windows ENOENT when running rolldown via execFileSync ([d804282](https://github.com/documonster/documonster/commit/d804282d60e95521a84716366e5219218b690465))
* Restore package.json and manifest to current released version ([5111e60](https://github.com/documonster/documonster/commit/5111e60d4fd1d7cee301b61e11190c67c66ece00))
* Revert bad release and fix release-please tag format ([79bb0be](https://github.com/documonster/documonster/commit/79bb0be3b2792d4e87efbd43f623c466113d724f))
* Revert unnecessary optional chaining for date1904 property access ([042f6c3](https://github.com/documonster/documonster/commit/042f6c35981208e284c4aeb60f6f2631cb32362b))
* Row height=0 ignored due to falsy-zero checks, add customHeight support ([9c91fdc](https://github.com/documonster/documonster/commit/9c91fdc8e3d2ac4a8dc44ea654a8c8cd2767e0e8)), closes [#82](https://github.com/documonster/documonster/issues/82)
* Sanitize table names to comply with OOXML defined name rules ([#91](https://github.com/documonster/documonster/issues/91)) ([b6f9b0e](https://github.com/documonster/documonster/commit/b6f9b0e7dd46872b066e90c6ece705931f082ffe))
* **security:** Eliminate remaining CodeQL regex and sanitization alerts ([7b2d5e7](https://github.com/documonster/documonster/commit/7b2d5e76d412cf4cf4efa5f1805520fee78492f3))
* **security:** Harden input parsing against DoS, prototype pollution, and crash vectors ([2eca761](https://github.com/documonster/documonster/commit/2eca761765f3bc5a42f56e6b79852967d50394a5))
* **security:** Replace regex-based XML extraction with linear scans to prevent polynomial-time backtracking vulnerabilities ([351bfae](https://github.com/documonster/documonster/commit/351bfae567bc726934a887dab2dc8d7be5bbb131))
* **security:** Resolve all CodeQL polynomial regex and sanitization alerts ([af2d0c5](https://github.com/documonster/documonster/commit/af2d0c5378a38e92b5209e261918e9f4a812a44a))
* Signing+forms AcroForm resources, restore drawText, normalize browser hash ([71d2281](https://github.com/documonster/documonster/commit/71d2281d13e226105d31c001cd037a95a52a2d9a))
* Stabilize flaky ZipCrypto checkPassword test ([b54eb15](https://github.com/documonster/documonster/commit/b54eb1544ce9f2e6e8f31c4006306a139e1f0c1d))
* **stream:** Align browser API surface with Node.js and add comprehensive tests ([6693fbb](https://github.com/documonster/documonster/commit/6693fbb6f9ba253aa0df427f2763ffae4c36e391))
* **stream:** Align browser Duplex/Transform end() and asyncDispose with Node.js behavior ([b0aa31f](https://github.com/documonster/documonster/commit/b0aa31fe7b10fcbc9854802d8f11af680da4f6a1))
* **stream:** Align browser edge-case behaviors with Node.js ([d216cb9](https://github.com/documonster/documonster/commit/d216cb9e6c59d21e24158b0d2e8040cd054e7eae))
* **stream:** Align browser pipeline, compose, duplexPair, and Writable with Node.js behavior ([851b37f](https://github.com/documonster/documonster/commit/851b37f4cafba97ac0fa85af6943d0c0b518fc64))
* **stream:** Align browser stream behavior with Node.js and add cross-platform test coverage ([3aaa945](https://github.com/documonster/documonster/commit/3aaa945bb8b42a562beb643f0b10e10db50ad8d0))
* **stream:** Align browser stream behavior with Node.js and harden internals ([e1220cc](https://github.com/documonster/documonster/commit/e1220ccf43515539a63c5343ed7869162195639e))
* **stream:** Align browser stream behavior with Node.js for _read, async iterators, setEncoding, and HWM defaults ([6d4a835](https://github.com/documonster/documonster/commit/6d4a83549936215a33d55867aa9ed3c3f418263a))
* **stream:** Align browser stream behavior with Node.js parity ([34f69c4](https://github.com/documonster/documonster/commit/34f69c4c4f9a4284efa504fbf491a79d1a45e462))
* **stream:** Align browser stream event timing and API behavior with Node.js ([d317bf2](https://github.com/documonster/documonster/commit/d317bf2279002c219813e2d31780c78b0c0a2e9b))
* **stream:** Align browser stream parity with Node.js for double-callback, destroyed writes, and shorthand removal ([5073134](https://github.com/documonster/documonster/commit/5073134d5ec565101a6047b9d3f393958f99bd7f))
* **stream:** Align read() with Node.js 26 behavior (return single chunk) ([5e90746](https://github.com/documonster/documonster/commit/5e9074695653307cf4e1f1ce072cf68bfab2aabb))
* **stream:** Comprehensive backpressure / deadlock hardening across all stream output paths ([3870df2](https://github.com/documonster/documonster/commit/3870df2bd135816edcf99803f6c11cf2f44ae683))
* **stream:** Constant-memory streaming for ZIP and Excel writers ([#88](https://github.com/documonster/documonster/issues/88)) ([532d7bb](https://github.com/documonster/documonster/commit/532d7bb7261893b2d13c54ced27e8db7c85c8a37))
* **stream:** Fix browser finished() arg parsing, Writable end() chunk normalization, and Duplex _undestroy() event forwarding ([7624d09](https://github.com/documonster/documonster/commit/7624d09d7589b3b4f332f619df7d7e27ba8bb530))
* **stream:** Harden browser compose() for Node.js parity ([7dc16e3](https://github.com/documonster/documonster/commit/7dc16e33721f0d6d69ff0015718396a69cc7267e))
* **stream:** Increase async transform error test timeout to prevent flaky failure ([a91642e](https://github.com/documonster/documonster/commit/a91642ec8fc3dfdfb6bc65977a71e0dd9882afff))
* **stream:** Refactor compose to use constructor options and fix double-event bugs ([2e1b88a](https://github.com/documonster/documonster/commit/2e1b88a97450d4c1a4909825764109a20c938bd8))
* **stream:** Resolve 12 browser-vs-Node.js behavioral inconsistencies ([388c1c1](https://github.com/documonster/documonster/commit/388c1c10dbc7ec85d3b73306558e43a2bcfaa900))
* **stream:** Support hex/base64/base64url/ascii in browser chunk.toString() ([3c86549](https://github.com/documonster/documonster/commit/3c86549565b9ea7d95ffdab37b723347324693ff))
* **stream:** Unify Node/browser API behavior and strengthen test quality ([121d824](https://github.com/documonster/documonster/commit/121d82460d96e55c79620ea1dcb54b59fb67da38))
* **stream:** Update read() behavior to align with Node.js 26+ and maintain backward compatibility ([85314fa](https://github.com/documonster/documonster/commit/85314fa624b94f82faeaf66de07b7238bf4e93d6))
* Support encrypted entries in streaming ZIP parse mode ([32a6c33](https://github.com/documonster/documonster/commit/32a6c330b53cf175a0f7ea8ee66e0548e153b89b))
* SVG T command bug, editor state leaks, signPdf pattern matching, orphaned catalogs ([a248e34](https://github.com/documonster/documonster/commit/a248e343b0cacad3a37cc914adf9b4ac4d08e147))
* **svg:** Replace regex parsing with manual attribute parser to avoid backtracking issues ([ce37fd1](https://github.com/documonster/documonster/commit/ce37fd1fdf45e8d3bb9bd125d46d535266cda1f3))
* **test:** Pin TAR modTime in byte-for-byte consistency test ([c163e49](https://github.com/documonster/documonster/commit/c163e49568ef7ef58c705dc4ce35b88eb59e86e8))
* **test:** Replace platform-dependent PNG hash with determinism check ([709d834](https://github.com/documonster/documonster/commit/709d83456e9062bef33812bceebc5b46a790540a))
* **tests:** Update transform and flush methods to use rest parameters for better argument handling ([fb8313a](https://github.com/documonster/documonster/commit/fb8313a23734eca39b52f56ce0381f9e8248a97a))
* **treeshake:** Improve tree-shaking for rspack/webpack and add verification script ([012493c](https://github.com/documonster/documonster/commit/012493c1ebb95550ff30c02e5bea70b38a24ecb9))
* **types:** Avoid DOM-only globals in emitted declarations ([4f21191](https://github.com/documonster/documonster/commit/4f21191f794fc15b27a5a20081f4ce98c079a076)), closes [#174](https://github.com/documonster/documonster/issues/174)
* Unify model field naming, strengthen types, and rewrite importSheet as deep copy ([cb381c7](https://github.com/documonster/documonster/commit/cb381c7acc54d341102f90b1e12b97638a705e69))
* Update benchmark import to per-module excel entry ([b0ef6c4](https://github.com/documonster/documonster/commit/b0ef6c440d57b1b6958b098ee29029cfa6f345e2))
* Update cspell words list and add oxlint dependency in package.json ([1a8691f](https://github.com/documonster/documonster/commit/1a8691f4e9282997b1e77b37c8664fa900dc88a3))
* Update image anchor positions when rows or columns are spliced ([#50](https://github.com/documonster/documonster/issues/50)) ([c164bec](https://github.com/documonster/documonster/commit/c164becdf233e1b96e9cff7ece2e8e2e9dc45990))
* Update TypeScript linting rules — add no-misused-spread and no-useless-default-assignment ([480b7c0](https://github.com/documonster/documonster/commit/480b7c083ad84e9c7518d9cabd38186f0c6ba5fa))
* Update worksheet fileIndex handling for consistency in ZIP entry paths ([5cda867](https://github.com/documonster/documonster/commit/5cda86708efb9007e86435157687a705019fb046))
* Use crypto.hash() instead of createHash() to resolve CodeQL alerts ([0125c19](https://github.com/documonster/documonster/commit/0125c192e86e49a840875430366d2a72f3677914))
* Use optional chaining for date1904 property access in XLSX class ([4e74f80](https://github.com/documonster/documonster/commit/4e74f805b1817a0a917c5fd73d7faf34f791810d))
* Use optional chaining for date1904 property access in XLSX class ([2bfbd90](https://github.com/documonster/documonster/commit/2bfbd90fe175b49400829bec1c001b172f33e189))
* Use process.execPath to run oxfmt in generate script for Windows compat ([fe83656](https://github.com/documonster/documonster/commit/fe83656e3a65cde20b3b084a8026c4f836613601))
* Wait for file stream close before resolving on Windows ([84503eb](https://github.com/documonster/documonster/commit/84503eba664b538eed74729de013c6345a2ed335))
* Widen RowValues object type from Record&lt;string, unknown&gt; to Record&lt;string, any&gt; ([9d29be6](https://github.com/documonster/documonster/commit/9d29be6dceecc92f76176316e01212a82d568399))
* Word patcher/incremental-edit correctness, agile-encryption perf, and deprecated cleanup ([fc27453](https://github.com/documonster/documonster/commit/fc274531c550d8d04760e172069681b56df7c958))
* **word, excel:** Close example coverage gaps and fix two latent bridge bugs ([0ac4945](https://github.com/documonster/documonster/commit/0ac49451ef2185b3b674331d1552c03bff46fe87))
* **word:** Broad round-trip correctness, security policy enforcement, and OOXML coverage ([ff6bec9](https://github.com/documonster/documonster/commit/ff6bec9a3351d2d4d82c4b6ff5b4de1782cfe53e))
* **word:** Correct HTML→DOCX class style merging and list/image handling ([8264c23](https://github.com/documonster/documonster/commit/8264c236c048b42cd8cc9cf83ec86e49e1167972))
* **word:** Correct list IR conversion, compat-mode round-trip, and INDEX field ([a8bf9bc](https://github.com/documonster/documonster/commit/a8bf9bcb692eb8768a1a56824f8557bf1f80faac))
* **word:** Correct math phantom visibility, MathML run tokenization, style-map overrides, and theme color casing ([82e6dd6](https://github.com/documonster/documonster/commit/82e6dd64a3b41b7cb3bb372f714a793a2c8a2a20))
* **word:** Four rounds of deep audit fixes across the word module ([f669d62](https://github.com/documonster/documonster/commit/f669d6208dc2329518558d5a0cc03fe6c9e39a8d))
* **word:** Hide empty degree when importing a square root from MathML ([aaf6992](https://github.com/documonster/documonster/commit/aaf69922cfcce4996bb6db9e26895ed999051386))
* **word:** Make encrypted and protected documents openable by Word ([f0ff64c](https://github.com/documonster/documonster/commit/f0ff64c12e3ba3072b5754f6ebcafe29a507636a))
* **word:** Optimize encryption info parsing by replacing regex with linear scans to avoid catastrophic backtracking in XML processing ([351bfae](https://github.com/documonster/documonster/commit/351bfae567bc726934a887dab2dc8d7be5bbb131))
* **word:** Preserve list structure and numbering format in ODT round-trip ([bf6736a](https://github.com/documonster/documonster/commit/bf6736a4aeea274b3998156d15f65edb10f251df))
* **word:** Rewrite HTML tokenizer and attribute parser as linear scans to eliminate polynomial-redos ([d0f5dac](https://github.com/documonster/documonster/commit/d0f5dac3fc4520bdc99c7ab844f0ee025d39dba7))
* **word:** Streamline HTML import processing by consolidating multiple regex replacements into a single linear scan for better efficiency ([351bfae](https://github.com/documonster/documonster/commit/351bfae567bc726934a887dab2dc8d7be5bbb131))
* WorkbookReader emits wrong worksheet name when workbook.xml is parsed after worksheets ([206e424](https://github.com/documonster/documonster/commit/206e4246201e74998038b07c7ede327ad6596956))
* **worksheet:** Remove unnecessary null check for worksheet name length ([b804e9c](https://github.com/documonster/documonster/commit/b804e9ce2dfb59d2c4b28a1c9b66564fa13993d8))
* WorksheetWriter.findCell used wrong property name (address.column → address.col) ([72ee159](https://github.com/documonster/documonster/commit/72ee159541536be85c7f893de3614b1b79f35cb1))
* Write ht="1" for height=0 rows to reliably trigger Excel auto-height ([69728a6](https://github.com/documonster/documonster/commit/69728a6ad6da6cb7bcf7c128dc2a7a75998f9193))
* **xml:** Complete namespace support, harden parser, simplify module, and update validator ([9a59fe8](https://github.com/documonster/documonster/commit/9a59fe88e35700d73612f05b1b4feb825e687d73))
* **xml:** Correct HAN CELL prefix detection, xmlEncode FFFE/FFFF, and tag mutation ([56c8665](https://github.com/documonster/documonster/commit/56c8665b40f3172b62156cb012c97216ed761b36))
* **xml:** Reject second root element, fatal UTF-8 decode, lightweight decodeCol ([95b676e](https://github.com/documonster/documonster/commit/95b676e07dbcb8e74b4a928051bc73a1961b9929))


### Code Refactoring

* **archive, stream:** Improve compression pipeline, browser stream API parity, and binary utils ([0ed6d28](https://github.com/documonster/documonster/commit/0ed6d28bb9859a2e1d1779cbdb8da3b8d03aa36e))
* **archive:** Extract shared ZIP output pipeline from ZipArchive and ZipEditor ([8912118](https://github.com/documonster/documonster/commit/89121189df2a31210c6bd430904761bc57cbfc48))
* **archive:** Remove redundant createArchive/createReader public API ([e6c4ff5](https://github.com/documonster/documonster/commit/e6c4ff516c8e898f9819bf1fc43b867cb8cc28df))
* **archive:** Reorganize module structure for cleaner boundaries ([f5c208a](https://github.com/documonster/documonster/commit/f5c208ae0ea4f5aa1b8dee507e60de2c63a8277e))
* **archive:** Restructure streaming inflate fallback; drop dead codemod vars ([b698caf](https://github.com/documonster/documonster/commit/b698caf6797a4b84fa31510927194b7ca03b5d56))
* Consolidate pivot-table examples and clean up project config ([24b26d7](https://github.com/documonster/documonster/commit/24b26d74046736ec5c17a796c146553b3c4f973b))
* Convert all .then() chains to async/await in integration tests ([6ba5dcc](https://github.com/documonster/documonster/commit/6ba5dcc11f87f6a4be52a21ba92a0a4781ec8dcc))
* **excel:** Extract shared worksheet utils and fix TS6 build compatibility ([2ac2885](https://github.com/documonster/documonster/commit/2ac2885a1452efef3233adcaa479fe5b1e395ff2))
* **excel:** Remove deprecated Image and ZipOptions type aliases ([ab499d5](https://github.com/documonster/documonster/commit/ab499d5566bff2ee5a530571c849de3a3a9d0168))
* **excel:** Replace old formula engine with new compile→evaluate→materialize pipeline ([b747df7](https://github.com/documonster/documonster/commit/b747df7f2a78174fdfcf7d83e3e273e46371a6a8))
* **formula:** Promote to top-level module with standalone entry + strict defined-name classification ([b34fe81](https://github.com/documonster/documonster/commit/b34fe818f3d7cd4d8a8514cbcba9e800cf20eae7))
* Improve tree-shaking across all modules ([49b2322](https://github.com/documonster/documonster/commit/49b232211005a3ab269a8b0ab11b1e6a07675cbc))
* Modernize excel module types and patterns ([07e3b89](https://github.com/documonster/documonster/commit/07e3b890e107b056bd8f521619b0ceed6b084b38))
* **pdf:** Decouple PDF engine from Excel, add standalone pdf() API ([a426eb4](https://github.com/documonster/documonster/commit/a426eb46ce71c594878c6fd4abeee1d5b7cba7ab))
* Remove dead code and tighten let/const usage ([29e0166](https://github.com/documonster/documonster/commit/29e016654e5cd61e9266449996c5491bef3fe082))
* Rename Md module to Markdown globally ([d0072ae](https://github.com/documonster/documonster/commit/d0072aee6f2e0cc2bfc6f8679f0a1125acd0eed6))
* Rename remaining md variables to markdown in examples, tests, and docs ([767bc12](https://github.com/documonster/documonster/commit/767bc1292212b48fc0e01664696b54e63904b0e9))
* Replace prettier with oxfmt, migrate typescript-eslint to tsgolint ([8e24fdb](https://github.com/documonster/documonster/commit/8e24fdb901863e929065266c83575529f457d5e6))
* Restructure entry points and add subpath exports for zip, csv, stream ([1905a4b](https://github.com/documonster/documonster/commit/1905a4bda6497f9e494613051ad3eaf6f3ec2de8))
* **stream:** Align stream behavior with Node.js for error handling and event emissions ([4d823a0](https://github.com/documonster/documonster/commit/4d823a0631406e1ed2aa3bddf21ef6aa5cf19de3))
* **stream:** Improve duplexPair function by using a holder object for stream references ([f33f088](https://github.com/documonster/documonster/commit/f33f0888f85d85e2f6feeff6aec2aaf60dfab1dc))
* **stream:** Modularize stream module architecture and deduplicate shared code ([f851804](https://github.com/documonster/documonster/commit/f851804ca3f3deeaa7e58989639c78f328aa6209))
* **stream:** Optimize stream composition and error handling for better performance and compatibility with Node.js ([cad6701](https://github.com/documonster/documonster/commit/cad67014b64acd06951113ce253531291d343a2b))
* **stream:** Unify cross-platform logic and extract shared utilities ([7cdca1a](https://github.com/documonster/documonster/commit/7cdca1adaeef7187932a39974f8b0a7487eb633f))
* Update AbortError implementation and related tests to use 'cause' instead of 'reason' ([ab21ce9](https://github.com/documonster/documonster/commit/ab21ce918bdda31388b9f30da94c2d256b28d9fc))
* **word:** Decompose document.ts into focused modules ([772cc2b](https://github.com/documonster/documonster/commit/772cc2be03b41ac56c776ac91bd909943e406d4f))
* **word:** Enhance markdown rendering by ensuring proper escaping of pipe characters to prevent table structure corruption ([351bfae](https://github.com/documonster/documonster/commit/351bfae567bc726934a887dab2dc8d7be5bbb131))
* **word:** Improve parsing of field conditions and attributes using linear scans instead of regex to enhance performance and security ([351bfae](https://github.com/documonster/documonster/commit/351bfae567bc726934a887dab2dc8d7be5bbb131))


### Performance Improvements

* **archive:** Batch small async push() calls in ZipDeflateFile (4.4x browser speedup) ([54a7a78](https://github.com/documonster/documonster/commit/54a7a78779e2eb9772dbdf32647e63d81132fc0d)), closes [#127](https://github.com/documonster/documonster/issues/127)
* Cache isDateFmt, use encodeInto in StringBuf, optimize row spans parsing ([3c63a07](https://github.com/documonster/documonster/commit/3c63a0723f4fe7c5eb4e030eeae91b723531f1ec))
* **xml:** Eliminate XML parse overhead with direct SAX callbacks ([74ebdaf](https://github.com/documonster/documonster/commit/74ebdaf0c3a6ad154f15161b2c09388567c008d5))
* **xml:** Optimize hot paths for large-data throughput ([97bd074](https://github.com/documonster/documonster/commit/97bd07497c7eba6afd5e805043459ce83355801b))
* **xml:** Optimize text decoding, SAX consumers, and write batching ([aaa41a9](https://github.com/documonster/documonster/commit/aaa41a956ab47f690c126ace6885f4885a7df85a))


### Miscellaneous Chores

* **excel:** Narrow XLSX return types to the concrete Workbook subclass ([#160](https://github.com/documonster/documonster/issues/160)) ([4380b6e](https://github.com/documonster/documonster/commit/4380b6e539d3085f988473e399386069843abff1))
* Release 9.4.1 ([0cf74c7](https://github.com/documonster/documonster/commit/0cf74c7574b2e8e503e326b00814d5ab79357de0))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
