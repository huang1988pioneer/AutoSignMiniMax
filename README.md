# AutoSignMiniMax

使用 GitHub Actions 自動完成 [MiniMax Agent](https://agent.minimax.io/) 的每日簽到。工作流程每日會在多個台北時間時段執行，也可以手動觸發；支援最多 33 個帳號，並在失敗時保留截圖以利排查。

流程沿用 AutoSignOiiOii 的架構（多帳號、Storage State、連續天數統計、桌面登入工具），但簽到動作改為 MiniMax 自己的介面：腳本只會點擊網站原生的簽到卡片按鈕，並以網站回傳的官方回應作為成功依據。

## 功能

- 每日自動執行，或從 GitHub Actions 手動執行
- 支援 1～33 個 MiniMax 帳號；未設定 Secret 的編號會自動略過
- 優先使用 Playwright Storage State，也可使用 Cookie Header
- 以 MiniMax 官方端點確認結果，不自行偽造簽到請求
- 找不到卡片或暫時失敗時，最多重試 3 次
- 自動上傳執行截圖為 Artifact，保留 7 天
- 不會嘗試繞過 OTP、Google 登入或 CAPTCHA

## MiniMax 的簽到流程

MiniMax Agent 的每日簽到由三個端點驅動，本專案完全依照網站自己的行為運作：

| 端點 | 用途 |
| --- | --- |
| `GET /minimax-cloud/api/v1/signin/status` | 取得 7 天週期的簽到面板（哪一天可簽、今天是否已簽、目前連續天數） |
| `POST /minimax-cloud/api/v1/signin/claim` | 網站在按下簽到按鈕時送出；回應 `claim_result` 為 `1`（完成）或 `2`（今日已簽） |
| `POST /matrix/api/v1/commerce/get_membership_info` | 提供剩餘積分，用於摘要中的「MiniMax credits」 |

MiniMax 會對自家請求加上簽章標頭（`yy`、`x-signature`、`token`），因此腳本不會自行呼叫 API，而是讓網頁自己送出請求、再讀取回應。實際操作為：

1. 以登入狀態開啟 `https://agent.minimax.io/`。
2. 等待網站送出 `signin/status`。今日可簽時，網站會自動展開簽到卡片（`[data-testid="signin-card"]`）；未自動展開時，改從左側帳號選單的「每日簽到」項目叫出同一張卡片。
3. 點擊卡片內的簽到按鈕（`button.signin-claim-button`）。
4. 等待 `signin/claim` 的回應，只有 MiniMax 回覆成功（或回覆今日已簽）才記為 `checked_in`。
5. 重新載入首頁以更新積分與登入狀態。

若 `signin/status` 顯示今日已簽到，流程不會重複點擊，直接視為成功。

## 設定 GitHub Actions

### 1. 取得登入狀態

建議使用 Playwright Storage State。MiniMax 的登入憑證放在 localStorage，Storage State 會一併保存，Cookie Header 則可能不足以維持登入，請優先使用 Storage State。

```bash
npx playwright codegen --save-storage=auth.json https://agent.minimax.io/
```

完成登入後關閉瀏覽器，將 `auth.json` 轉為單行 Base64：

```bash
# macOS / Linux
base64 -w0 auth.json
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('auth.json'))
```

### 2. 新增 Repository Secrets

前往 GitHub 儲存庫的 **Settings → Secrets and variables → Actions**，建立下列 Secrets。

| Secret | 用途 |
| --- | --- |
| `MINIMAX_STORAGE_STATE_B64_1` … `MINIMAX_STORAGE_STATE_B64_33` | 各帳號的 Base64 Storage State（建議） |
| `MINIMAX_COOKIE_1` … `MINIMAX_COOKIE_33` | 各帳號的 Cookie Header（可替代 Storage State） |
| `MINIMAX_SECRET_WRITE_TOKEN` | 選用。具備 `Secrets: read and write` 權限的 PAT，用於自動輪替登入狀態 |

每個帳號只要設定其中一種登入方式即可，且 Storage State 優先。workflow 會執行全部 33 個編號；未設定 Secret 的帳號會自動略過，不必連續編號。

帳號別名可用 Variables `MINIMAX_ACCOUNT_NAME_1` … `MINIMAX_ACCOUNT_NAME_33` 指定；未設定時，編號 `1`、`2`、`3` 會顯示為 `huang1988pioneer`、`abuhg17`、`goldshoot0720`，其餘顯示為 `account-N`。

請勿把 `auth.json`、Cookie 或任何登入憑證提交到儲存庫。

### 3. 手動驗證

開啟儲存庫的 **Actions** 分頁，選擇 **MiniMax daily check-in**，再按 **Run workflow**。執行完成後，可在 Job Summary 查看每日彙總，並在該次 workflow 的 Artifacts 下載截圖與 `minimax-checkin-report`。

`daily-summary` 也會使用 `GITHUB_TOKEN` 自動建立或更新 **`result` 分支**的 `streaks.json`，並將同一份 JSON 附在 `minimax-checkin-report`。只有此 job 取得 `contents: write` 權限；若儲存庫規則禁止 Actions 寫入該分支，發布步驟會報錯。

JSON 採用 `generatedAt`、`runUrl`、`title`、`accounts`、`summary` 結構；每個帳號提供 `account`、`name`、`label`、`status`、`finishedAt`、`currentPoints`、相同數值的 `remainingCredits`，以及 `siteStreak`（MiniMax 自己顯示的本週期連續天數）。零積分保留為 `0`，無法取得則為 `null`。連續簽到天數 `streak` 由本專案的成功紀錄計算（`streakSource: recorded_check_ins`），以台北日期為準，並保存 `lastCheckInDate` 與去重後的 `checkInDates`。同日重跑或已簽到不會重複加天；連續兩日成功會加 1，漏簽後下次成功從 1 開始。同日失敗或略過不會抹除已成功紀錄。首次啟用從首次觀測成功算起，不追溯網站上既有天數。公開檔案不包含登入狀態、Cookie 或錯誤訊息。

## 每日自動執行時段

GitHub Actions 每天會在下列台北時間（UTC+8）各自執行一次：

| 時段 | 執行方式 |
| --- | --- |
| 05:00–06:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |
| 08:00 | 08:00 觸發執行 |
| 08:18 | 08:18 觸發執行 |
| 09:19 | 09:19 觸發執行 |
| 11:00 | 11:00 觸發執行 |
| 13:00–14:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |
| 21:00–22:00 | 整點觸發後，隨機等待 0–59 分鐘再開始 |

同一次 workflow 中，帳號 1 會先執行；每個後續帳號都會在前一個帳號後再隨機延遲 **5–15 秒**，避免 33 個帳號同時操作。GitHub 的排程本身也可能延遲，因此實際開始時間可能略晚於上述時段。

## 在本機執行

需求：Node.js 22（CI 使用版本）與可安裝 Chromium 的環境。

```bash
npm install
npx playwright install chromium

# 二選一：設定 Storage State 或 Cookie
export MINIMAX_STORAGE_STATE_B64='...'
# export MINIMAX_COOKIE='session=...'

npm run claim
```

```powershell
npm install
npx playwright install chromium
$env:MINIMAX_STORAGE_STATE_B64 = '...'
# 或：$env:MINIMAX_COOKIE = 'session=...'

npm run claim
```

檢查語法與單元測試：

```bash
npm run check
npm test
```

## 環境變數

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `MINIMAX_STORAGE_STATE_B64` | 無 | Base64 編碼的 Playwright Storage State JSON |
| `MINIMAX_COOKIE` | 無 | 完整 Cookie Header |
| `MINIMAX_ACCOUNT_NAME` | `default` | 用於日誌與截圖檔名的帳號識別 |
| `MINIMAX_ACCOUNT_NUMBER` | 無 | 帳號編號，決定要輪替的 Secret 名稱 |
| `MINIMAX_MAX_RETRIES` | `3` | 最大嘗試次數 |
| `MINIMAX_SCREENSHOT_DIR` | `./screenshots` | 截圖輸出資料夾 |
| `MINIMAX_RESULT_DIR` | `./artifacts` | 單一帳號結果 JSON 的輸出資料夾 |
| `MINIMAX_BROWSER` | `chromium` | 可改為 `firefox` 或 `edge` |
| `MINIMAX_ORIGIN` | `https://agent.minimax.io` | 站台來源，可指向 `https://agent.minimax.cn` |
| `MINIMAX_SESSION_WARN_DAYS` | `7` | 登入狀態剩餘天數低於此值時發出警告 |
| `MINIMAX_SECRET_WRITE_TOKEN` | 無 | 具 Secrets 寫入權限的 PAT，用於自動輪替登入狀態 |
| `MINIMAX_STATUS_TIMEOUT_MS` | `30000` | 等待 `signin/status` 的逾時 |
| `MINIMAX_CARD_TIMEOUT_MS` | `15000` | 等待簽到卡片出現的逾時 |
| `MINIMAX_CLAIM_TIMEOUT_MS` | `30000` | 等待 `signin/claim` 回應的逾時 |

## 桌面登入工具（macOS、Linux、Windows）

專案內含 Avalonia 桌面工具，可協助建立並複製 Storage State：

```bash
dotnet run --project MiniMaxFlow/MiniMaxFlow.csproj
```

1. 選擇帳號編號，按下建立登入狀態。
2. 在開啟的瀏覽器完成 MiniMax 登入，然後關閉瀏覽器。
3. 預設會自動同步到 GitHub Actions：登入狀態寫入 `MINIMAX_STORAGE_STATE_B64_N` Secret，帳號別名寫入 `MINIMAX_ACCOUNT_NAME_N` Variable；也可以關閉自動同步後改用手動按鈕或複製 Base64。

首次同步前，請在 PowerShell 執行 `gh auth login -h github.com`，並以具備此儲存庫 Actions Secrets 與 Variables 寫入權限的 GitHub 帳號完成登入。登入狀態會透過 GitHub CLI 的標準輸入傳送，不會出現在命令列、工具畫面或日誌中。

工具會優先使用電腦已安裝的 Microsoft Edge，其次是 Google Chrome，因此通常不需要下載 Playwright Chromium。若兩者都找不到，才會下載內建 Chromium；下載或解壓縮超過 5 分鐘會自動停止並顯示可採取的修復方式。

## 疑難排解

- **登入狀態過期**：重新取得 Storage State，並更新對應的 GitHub Secret。MiniMax 的憑證放在 localStorage，只複製 Cookie 通常不足。
- **沒有觀察到 `signin/status`**：截圖多半會顯示登入頁或地區限制頁。確認該帳號可以正常開啟 `https://agent.minimax.io/`；中國站請改設 `MINIMAX_ORIGIN=https://agent.minimax.cn`。
- **找不到簽到卡片**：MiniMax 調整側邊欄時會發生。到 workflow 的 Artifact 查看截圖，並調整 `scripts/claim-daily-check-in.mjs` 中的 `CARD`、`CLAIM_BUTTON`、`MENU_ENTRY` 選擇器。
- **今日沒有可簽到的日子**：`signin/status` 回報沒有 `Claimable` 的天數且今天未簽到，通常代表該帳號目前不在簽到活動內。
- **排程沒有準時執行**：GitHub Actions 的排程可能延遲，尤其在整點附近；可先手動執行驗證設定。
- **需要 OTP、Google 登入或 CAPTCHA**：先在本機正常完成登入，再更新 Storage State；此專案不會自動繞過驗證。

## 安全提醒

登入憑證等同帳號存取權。僅將它們放在 GitHub Secrets 或本機環境變數中，並在懷疑外洩時立即撤銷登入工作階段與更新憑證。
