#!/usr/bin/env bash
# scripts/lib/tokens.sh — cc-g2 トークン管理・.env 設定解決
# source して使う。直接実行しない。
#
# 呼び出し側の前提:
#   - set -euo pipefail 済み
#   - lib/common.sh を source 済み（resolve_env_var を使う）
#   - G2_PROJECT_DIR, HUB_PORT, VOICE_ENTRY_PORT,
#     HUB_AUTH_TOKEN_FILE, VOICE_ENTRY_TOKEN_FILE が定義済み
#   - warn はエントリ側（cc-g2.sh）で定義済み

# ─── API キー・設定フラグの解決 ──────────────────────────────

resolve_groq_api_key() {
  resolve_env_var "GROQ_API_KEY" "GROQ_API_KEY" "$G2_PROJECT_DIR"
}

resolve_openai_api_key() {
  resolve_env_var "OPENAI_API_KEY" "OPENAI_API_KEY" "$G2_PROJECT_DIR"
}

resolve_soniox_api_key() {
  resolve_env_var "SONIOX_API_KEY" "SONIOX_API_KEY" "$G2_PROJECT_DIR"
}

resolve_statusline_flag() {
  resolve_env_var "CC_G2_ENABLE_STATUSLINE" "CC_G2_ENABLE_STATUSLINE" "$G2_PROJECT_DIR"
}

secure_token_file() {
  local file="$1"
  if ! chmod 600 "$file" 2>/dev/null; then
    warn "Could not set 0600 permissions on token file: $file"
  fi
}

load_or_create_hub_auth_token() {
  if [ -n "${HUB_AUTH_TOKEN:-}" ]; then
    printf '%s' "$HUB_AUTH_TOKEN"
    return
  fi
  if [ -f "$HUB_AUTH_TOKEN_FILE" ]; then
    secure_token_file "$HUB_AUTH_TOKEN_FILE"
    cat "$HUB_AUTH_TOKEN_FILE"
    return
  fi
  mkdir -p "$(dirname "$HUB_AUTH_TOKEN_FILE")"
  ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$HUB_AUTH_TOKEN_FILE" )
  secure_token_file "$HUB_AUTH_TOKEN_FILE"
  cat "$HUB_AUTH_TOKEN_FILE"
}

load_or_create_voice_entry_token() {
  local token="${CC_G2_VOICE_ENTRY_TOKEN:-}"
  if [ -n "$token" ] && [ "$token" != "replace-me" ]; then
    printf '%s' "$token"
    return
  fi
  if [ -f "$VOICE_ENTRY_TOKEN_FILE" ]; then
    secure_token_file "$VOICE_ENTRY_TOKEN_FILE"
    token="$(cat "$VOICE_ENTRY_TOKEN_FILE")"
    if [ -n "$token" ] && [ "$token" != "replace-me" ]; then
      printf '%s' "$token"
      return
    fi
  fi
  mkdir -p "$(dirname "$VOICE_ENTRY_TOKEN_FILE")"
  ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$VOICE_ENTRY_TOKEN_FILE" )
  secure_token_file "$VOICE_ENTRY_TOKEN_FILE"
  cat "$VOICE_ENTRY_TOKEN_FILE"
}

resolve_voice_entry_enabled() {
  local value
  value="$(resolve_env_var "CC_G2_VOICE_ENTRY_ENABLED" "CC_G2_VOICE_ENTRY_ENABLED" "$G2_PROJECT_DIR")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return
  fi
  # VOICE_ENTRY_ENABLED が空でも TOKEN が設定されていれば有効
  if [ -n "${CC_G2_VOICE_ENTRY_TOKEN:-}" ]; then
    printf '1'
    return
  fi
  printf '1'
}

resolve_repo_roots() {
  resolve_env_var "CC_G2_REPO_ROOTS" "CC_G2_REPO_ROOTS" "$G2_PROJECT_DIR" "${HOME}/Repos"
}

# ─── トークンの再読込 ────────────────────────────────────────

refresh_hub_auth_token() {
  unset HUB_AUTH_TOKEN
  HUB_AUTH_TOKEN="$(load_or_create_hub_auth_token)"
}

refresh_voice_entry_token() {
  unset CC_G2_VOICE_ENTRY_TOKEN
  VOICE_ENTRY_TOKEN="$(load_or_create_voice_entry_token)"
}

# ─── トークン照合（起動中プロセスとの一致確認） ──────────────

voice_entry_token_matches() {
  [ "$VOICE_ENTRY_ENABLED" = "1" ] || return 0
  [ -n "${VOICE_ENTRY_TOKEN:-}" ] || return 1
  local code
  code=$(
    curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      -H "authorization: Bearer ${VOICE_ENTRY_TOKEN}" \
      "http://127.0.0.1:${VOICE_ENTRY_PORT}/auth-check" 2>/dev/null || true
  )
  [ "$code" = "200" ]
}
hub_auth_token_matches() {
  [ -n "${HUB_AUTH_TOKEN:-}" ] || return 1
  [ -f "$HUB_AUTH_TOKEN_FILE" ] || return 1
  local code
  for _ in 1 2; do
    code=$(
      curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
        -H "X-CC-G2-Token: ${HUB_AUTH_TOKEN}" \
        "http://127.0.0.1:${HUB_PORT}/api/auth-check" 2>/dev/null || true
    )
    [ "$code" = "200" ] && return 0
    sleep 0.2
  done
  return 1
}
