---
name: 🐛 Bug report
about: Create a report to help us improve
title: "[BUG] XYZ"
labels: ":bug: Bug"
---

## 🐛 Bug Report

<!-- A clear and concise description of what the bug is. -->

Lib version: X.Y.Z
Node version: X.Y.Z
Browser (if applicable): Chrome/Firefox/Safari X.Y.Z

## Steps To Reproduce

<!-- The exact steps required to reproduce the issue, ideally with a code example -->

```javascript
import { Workbook } from "@cj-tech-master/excelts";

const wb = new Workbook();
const ws = wb.addWorksheet("XYZ");

ws.getCell("A1").value = 7;
expect(ws.getCell("A1").value).to.equal(7);
```

## The expected behaviour:

<!-- A clear and concise description of what you expected to happen. -->

## Possible solution (optional, but very helpful):

```javascript

```
