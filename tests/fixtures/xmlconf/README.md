# W3C XML Conformance Test Suite (selection)

The tests here are a selection from the W3C XML Conformance Test Suite
(xmlconf, 2013-09-23 release), as packaged by the npm module
[`xml-conformance-suite`](https://www.npmjs.com/package/xml-conformance-suite)
1.2.0. The selection covers XML 1.0 (5th edition) and Namespaces in XML 1.0:
the `not-wf`, `valid` and `invalid` tests whose `ENTITIES` is `none`, so that
no external entity is ever needed. `manifest.json` lists them with their
types, paths, expected outputs and descriptions; `tests/xmlconf.test.ts`
runs them.

The suite is © W3C and the contributing organisations (James Clark, Sun,
OASIS/NIST, IBM, Fuji Xerox, the University of Edinburgh), distributed
under the W3C Software Notice and License in `LICENSE.W3C`.
