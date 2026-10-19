#!/usr/bin/env bash
# Userscript metadata policy checks（單一來源，供 policy-check.yml 與 build-devtools.yml 的 gate 共用）。
#
# 檢查每個 scripts/*.user.js 的 @updateURL / @downloadURL 是否指向正確位置。
# Legacy shim（舊檔名保留以便既有 Tampermonkey 安裝能遷移）需指向繼任腳本。
#
# 用法：bash tools/policy-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

status=0

for file in scripts/*.user.js; do
  if [ ! -f "$file" ]; then
    continue
  fi

  script_name="$(basename "$file")"

  # Legacy migration shims: kept under the old filename so existing
  # Tampermonkey installs keep updating, but their update/download URLs
  # must point at the successor script so those installs migrate to it.
  # Format: "<old filename>:<successor filename>"
  target_name="$script_name"
  for shim in "login-ocr.user.js:login-helper.user.js"; do
    if [ "$script_name" = "${shim%%:*}" ]; then
      target_name="${shim##*:}"
      if [ ! -f "scripts/${target_name}" ]; then
        echo "::error file=${file}::Legacy shim points at missing successor scripts/${target_name}"
        status=1
      fi
    fi
  done

  expected_url="https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/${target_name}"

  if ! grep -Eq "^// @updateURL[[:space:]]+${expected_url}$" "$file"; then
    echo "::error file=${file}::Missing or invalid @updateURL. Expected: ${expected_url}"
    status=1
  fi

  if ! grep -Eq "^// @downloadURL[[:space:]]+${expected_url}$" "$file"; then
    echo "::error file=${file}::Missing or invalid @downloadURL. Expected: ${expected_url}"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "✓ Userscript metadata policy checks passed"
fi

exit "$status"
