# Technical Debt

## Forgot Password: Full Database Reset

**Current behavior:** "Forgot password" button only deletes `admin_password_hash` and `admin_password_salt` from settings table, allowing re-login with VW_ADMIN_TOKEN.

**Expected behavior:** Should reset the entire config.db (delete all accounts, settings, pending approvals), matching the original plan: "忘记密码 = 删除 config.db 重置".

**Implementation notes:**
- Add `resetAllData()` to `config-db.ts` — clear all tables, reinitialize defaults
- Update `POST /api/admin/reset-password` in `admin-api.ts` to call `resetAllData()` and stop all running bw serve instances via `account-manager.ts`
- Consider: should encryption.key also be deleted? Probably not, as it's independent of admin auth
- This is a destructive operation — the UI should clearly warn the user
