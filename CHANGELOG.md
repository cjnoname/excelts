# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Full TypeScript rewrite with strict typing
- Named exports for better tree-shaking
- Browser testing support with Playwright
- Husky v9 for Git hooks
- lint-staged for pre-commit checks
- Prettier configuration for consistent code style
- .npmignore for optimized package publishing
- Comprehensive browser and Node.js version requirements documentation

### Changed

- Migrated from ExcelJS to ExcelTS
- All default exports converted to named exports
- Updated all dependencies to latest versions
- Migrated testing framework from Mocha to Vitest
- Switched bundler from Webpack to Rolldown
- Build system using tsgo (TypeScript native compiler)
- Target ES2020 for better compatibility
- Node.js requirement: >= 14.0.0 (previously >= 12.0.0)
- Browser requirements: Chrome 85+, Firefox 79+, Safari 14+, Edge 85+, Opera 71+

### Improved

- Enhanced type safety with proper access modifiers
- Performance optimizations in build process
- Reduced package size by excluding source files from npm publish
- Optimized IIFE builds with conditional sourcemaps
- Better error handling and logging (development-only console warnings)

### Fixed

- typescript-eslint moved to devDependencies (was incorrectly in dependencies)
- Fixed preversion script to run proper checks before version bump
- Updated postversion to use --follow-tags instead of separate push commands

## [0.1.0] - 2024-10-24

### Added

- Initial release of ExcelTS
- Full TypeScript support
- Modern ES Module support
- CommonJS compatibility
- Browser IIFE builds

---

## Migration from ExcelJS

If you're migrating from ExcelJS, note these breaking changes:

### Import Changes

```javascript
// Before (ExcelJS)
import ExcelJS from "exceljs";
const workbook = new ExcelJS.Workbook();

// After (ExcelTS)
import { Workbook } from "@cj-tech-master/excelts";
const workbook = new Workbook();
```

### Browser Usage

```javascript
// Before (ExcelJS)
import ExcelJS from "exceljs";

// After (ExcelTS)
import { Workbook } from "@cj-tech-master/excelts/browser";
// Or use IIFE build with <script> tag
```

For more details, see [README.md](README.md).
