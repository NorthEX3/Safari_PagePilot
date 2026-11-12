#!/bin/bash
# 一键发版：同步版本号 → 生成 Xcode 工程 → 构建 .app → 打包 dmg 和 zip。
# 只能在装有 Xcode 的 macOS 上运行。
#
# 用法：
#   scripts/release.sh patch       # 0.18.1 -> 0.18.2
#   scripts/release.sh minor       # 0.18.1 -> 0.19.0
#   scripts/release.sh major       # 0.18.1 -> 1.0.0
#   scripts/release.sh 0.20.0      # 指定版本号
#   scripts/release.sh --no-bump   # 不改版本号，只重新打包
#
# 环境变量：
#   BUNDLE_ID      App 的 bundle identifier（默认 com.northex3.PagePilot）。
#                  发布后不要再改，否则用户那边会被当成新扩展。
#   SIGN_IDENTITY  签名身份（默认 "-"，即本地临时签名）。
#                  正式分发请设为 "Developer ID Application: 你的名字 (TEAMID)"。
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="PagePilot"
BUNDLE_ID="${BUNDLE_ID:-com.northex3.PagePilot}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
MANIFEST="extension/manifest.json"
BUILD_DIR="$PWD/build"
DIST_DIR="$PWD/dist"

if [[ "$(uname)" != "Darwin" ]]; then
    echo "需要在 macOS 上运行（依赖 Xcode、hdiutil、ditto）"
    exit 1
fi
for tool in xcrun xcodebuild hdiutil ditto python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "缺少命令：$tool"; exit 1; }
done

ARG="${1:-}"
if [[ -z "$ARG" ]]; then
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

# ---------- 1. 同步版本号 ----------
CURRENT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")

if [[ "$ARG" == "--no-bump" ]]; then
    VERSION="$CURRENT"
else
    VERSION=$(python3 - "$CURRENT" "$ARG" <<'PY'
import re, sys
cur, arg = sys.argv[1], sys.argv[2]
if re.fullmatch(r"\d+\.\d+\.\d+", arg):
    print(arg); sys.exit()
major, minor, patch = map(int, cur.split("."))
if arg == "patch":   patch += 1
elif arg == "minor": minor, patch = minor + 1, 0
elif arg == "major": major, minor, patch = major + 1, 0, 0
else:
    sys.exit("版本参数应为 patch/minor/major/x.y.z/--no-bump")
print(f"{major}.{minor}.{patch}")
PY
)
    # 只替换 version 这一行，保留 manifest 其余格式
    python3 - "$MANIFEST" "$VERSION" <<'PY'
import re, sys
path, ver = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s, n = re.subn(r'("version"\s*:\s*")[^"]+(")', r'\g<1>' + ver + r'\g<2>', s, count=1)
assert n == 1, "manifest.json 里没找到 version"
open(path, "w", encoding="utf-8").write(s)
PY
fi

# Build 号必须单调递增：用 git 提交数；没有 git 时用时间戳
BUILD_NUMBER=$(git rev-list --count HEAD 2>/dev/null || date +%Y%m%d%H%M)
echo "==> 版本 ${CURRENT} -> ${VERSION}（build ${BUILD_NUMBER}）"

# ---------- 2. 生成 Xcode 工程 ----------
# 每次重新生成，这样新增/删除的扩展文件也会被带上。build/ 不进 git。
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

echo "==> 转换为 Safari 扩展工程 ..."
xcrun safari-web-extension-converter extension/ \
    --project-location "$BUILD_DIR/xcode" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --macos-only --no-open --no-prompt --force

PROJECT=$(find "$BUILD_DIR/xcode" -maxdepth 3 -name "${APP_NAME}.xcodeproj" | head -1)
[[ -n "$PROJECT" ]] || { echo "未找到生成的 ${APP_NAME}.xcodeproj"; exit 1; }

# ---------- 3. 构建 .app ----------
# 版本号通过构建参数覆盖，App 和扩展两个 target 都会用同一个值（Safari 要求一致）。
echo "==> 构建 Release ..."
xcodebuild -project "$PROJECT" -scheme "$APP_NAME" -configuration Release \
    -derivedDataPath "$BUILD_DIR/derived" \
    MARKETING_VERSION="$VERSION" \
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
    CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="" \
    build

APP_PATH="$BUILD_DIR/derived/Build/Products/Release/${APP_NAME}.app"
[[ -d "$APP_PATH" ]] || { echo "构建产物不存在：$APP_PATH"; exit 1; }

# 构建参数没生效时尽早发现
BUILT_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")
[[ "$BUILT_VERSION" == "$VERSION" ]] || { echo "App 版本是 ${BUILT_VERSION}，应为 ${VERSION}"; exit 1; }

# xcodebuild 会把构建目录里的 .app 登记到系统，Safari 会多出一个重复的扩展，这里注销掉
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister
"$LSREGISTER" -u "$APP_PATH" >/dev/null 2>&1 || true

# ---------- 4. 打包 dmg 和 zip ----------
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}.dmg"
ZIP_PATH="$DIST_DIR/${APP_NAME}-${VERSION}.zip"
rm -f "$DMG_PATH" "$ZIP_PATH"

echo "==> 生成 dmg ..."
STAGE="$BUILD_DIR/dmg-stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"
ditto "$APP_PATH" "$STAGE/${APP_NAME}.app"
ln -s /Applications "$STAGE/Applications"   # 窗口里显示“应用程序”文件夹，方便拖拽
hdiutil create -volname "${APP_NAME} ${VERSION}" -srcfolder "$STAGE" \
    -ov -format UDZO "$DMG_PATH" >/dev/null

echo "==> 生成 zip ..."
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"   # 必须用 ditto，普通 zip 会破坏签名

echo ""
echo "✅ 完成 v${VERSION}"
echo "   $DMG_PATH"
echo "   $ZIP_PATH"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
    echo "   （本地临时签名：用户首次打开需在“隐私与安全性”点“仍要打开”，"
    echo "     并在 Safari 开发者设置里允许未签名扩展）"
fi
echo ""
echo "下一步："
echo "   git add -A && git commit -m \"Release v${VERSION}\" && git tag v${VERSION}"
echo "   把 dist/ 里的文件上传到 GitHub Releases"
