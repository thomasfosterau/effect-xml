# W3C QT3 test suite (selection)

The files here are a byte-for-byte copy of part of the W3C XQuery / XPath test suite, [QT3](https://github.com/w3c/qt3tests), at commit `201a6e466940cdfc727f4babfedcde5332b9f578` (2026-05-14). Nothing has been changed, reformatted or renamed; this README is the only file that is ours.

The selection is what `tests/qt3.test.ts` runs (see `tests/support/qt3.ts`):

- `catalog.xml`, the suite's catalog (it still lists the test sets of `app/` and `ser/`, which the harness skips);
- the test sets under `fn/`, `op/`, `prod/`, `math/`, `map/`, `array/`, `xs/` and `misc/`, with every file they reference;
- `docs/`, the source documents the catalog's shared environments use;
- `app/FunctxFn/functx_book.xml` and `app/XMark/XMarkAuction.xml`, the two files outside those directories that the selected test sets reference.

Three files the selected test sets reference are missing upstream at this commit (`fn/doc.xml` names `f0`, `prod/ModuleImport.xml` names `ModuleImport/module-urisi1-lib.xq`, `prod/OptionDecl.serialization.xml` names `Serialization/serialization1.xml`); the tests that need them fail.

## Licence

The suite's own documentation (`guide/running.html` at the commit above) says:

> The QT3 test suite is made available under the terms of the W3C Licenses described at: http://www.w3.org/Consortium/Legal/2008/04-testsuite-copyright
>
> Where these licenses prohibit alteration of test material, such prohibition does not apply to alterations explicitly permitted in this documentation.

That page is the W3C's 2008 licensing policy for test suites, which (as we understand it; the page could not be fetched when this selection was vendored) offers W3C test suites under the W3C Test Suite License and the W3C 3-clause BSD License; read it for the exact terms. The repository has no `LICENSE` file of its own, and its `w3c.json` declares `"policy": "open"`. The test material is © W3C and the contributors to the suite. Its pages carry the W3C copyright, trademark, document use and software licensing notices (http://www.w3.org/Consortium/Legal/ipr-notice, http://www.w3.org/Consortium/Legal/copyright-software).

`misc/JSONTestSuite/` (from Nicolas Seriot's JSONTestSuite) carries its own MIT licence in `misc/JSONTestSuite/LICENSE`.
