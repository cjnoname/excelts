# Release Strategy

This project uses a **Canary Release** strategy for continuous delivery.

## 📦 Two Release Channels

### 1. **Canary** (Automated, Testing)

- **Trigger**: Every push to `main` branch
- **Version**: `0.1.0-canary.20251024120530.abc1234`
- **npm tag**: `canary`
- **Purpose**: Early testing, CI/CD validation

**Install canary version:**

```bash
npm install @cj-tech-master/excelts@canary
# or specific version
npm install @cj-tech-master/excelts@0.1.0-canary.20251024120530.abc1234
```

### 2. **Stable** (Manual, Production)

- **Trigger**: Push a git tag (e.g., `v0.1.0`)
- **Version**: `0.1.0` (semantic versioning)
- **npm tag**: `latest`
- **Purpose**: Production-ready releases

**Install stable version:**

```bash
npm install @cj-tech-master/excelts
# or
npm install @cj-tech-master/excelts@latest
```

## 🚀 Release Workflow

### For Canary Releases (Automatic)

1. Merge PR to `main`
2. GitHub Actions automatically:
   - Runs tests
   - Builds the project
   - Generates canary version (e.g., `0.1.0-canary.TIMESTAMP.COMMITHASH`)
   - Publishes to npm with `canary` tag
   - Comments on the commit with installation instructions

### For Stable Releases (Manual)

1. Ensure `main` is stable and tested
2. Create a new version:
   ```bash
   npm version patch   # 0.1.0 → 0.1.1
   # or
   npm version minor   # 0.1.0 → 0.2.0
   # or
   npm version major   # 0.1.0 → 1.0.0
   ```
3. This automatically:
   - Updates `package.json` version
   - Creates a git commit
   - Creates a git tag (e.g., `v0.1.1`)
   - Pushes to GitHub (via `postversion` hook)
4. GitHub Actions automatically:
   - Runs tests
   - Builds the project
   - Publishes to npm with `latest` tag
   - Creates GitHub Release with auto-generated notes

## 📋 Version Number Format

### Canary

```
{base_version}-canary.{timestamp}.{commit_hash}
Example: 0.1.0-canary.20251024120530.abc1234
```

- `base_version`: Current version from package.json
- `timestamp`: YYYYMMDDHHmmss format
- `commit_hash`: Short git commit hash (7 chars)

### Stable

```
{major}.{minor}.{patch}
Example: 0.1.0
```

Follows [Semantic Versioning](https://semver.org/):

- **Patch** (0.1.0 → 0.1.1): Bug fixes
- **Minor** (0.1.0 → 0.2.0): New features (backward compatible)
- **Major** (0.1.0 → 1.0.0): Breaking changes

## 🔍 Checking Versions

### List all versions on npm

```bash
npm view @cj-tech-master/excelts versions
```

### Check latest canary

```bash
npm view @cj-tech-master/excelts@canary version
```

### Check latest stable

```bash
npm view @cj-tech-master/excelts@latest version
```

## ⚙️ Setup Requirements

To enable automated publishing, configure the following GitHub Secrets:

1. **NPM_TOKEN**: npm authentication token
   - Go to npmjs.com → Account Settings → Access Tokens
   - Create a new token with "Automation" type
   - Add to GitHub: Settings → Secrets and variables → Actions → New repository secret

## 🎯 Best Practices

1. **Always test canary versions** before creating stable releases
2. **Use stable versions in production** applications
3. **Use canary versions for testing** new features
4. **Write clear commit messages** - they appear in auto-generated release notes
5. **Update CHANGELOG.md** manually before stable releases

## 📚 Related Files

- `.github/workflows/release.yml` - Automated release workflow
- `package.json` - Version configuration and scripts
- `CHANGELOG.md` - Manual changelog for stable releases
