---
name: update-prices
description: 依官方價目表更新 AI Token 用量儀表板的模型價格（Claude 與 OpenAI Codex 模型）。只在使用者明確要求時使用，例如「更新模型價格」「價格表過期了」「儀表板說有未定價的模型」「幫我補上新模型的價格」。不要在使用者沒要求時自動執行。
---

# 更新模型價格

用官方價目表更新儀表板的價格。流程一定是：**查目前狀態 → 讀官方價目 → 列出差異 → 使用者確認 → 寫入**。沒有使用者明確同意前，不要寫入任何價格。

## 腳本位置

腳本在這個 plugin 的 `scripts/` 資料夾，也就是**本 SKILL.md 所在資料夾往上兩層**的 `scripts/`：

- Claude Code：`${CLAUDE_PLUGIN_ROOT}/scripts/`
- Codex 或其他工具：`<本檔案所在資料夾>/../../scripts/`

下面用 `SCRIPTS` 代表這個路徑。需要 Node.js 18 以上。

## 步驟

### 1. 查目前狀態

```bash
node "SCRIPTS/start.js" --no-open
node "SCRIPTS/prices.js" show
```

輸出包含：
- `baseUpdated`：目前基準價格表的日期；`staleDays`：距今幾天
- `unpriced`：這台電腦用過、但價格表裡找不到的模型（最需要補的）
- `seenModels`：這台電腦用過的所有模型；`priceKey` 和 `model` 不同代表是用相近模型的價格
- `prices`：目前生效的價格（`claude`、`codex` 兩張表，單位是美元 / 百萬 token）

### 2. 讀官方價目表

只用官方來源，用你的網頁讀取工具（例如 WebFetch）讀取：

| 工具 | 官方價目 |
|---|---|
| Claude（Anthropic） | https://platform.claude.com/docs/en/about-claude/pricing |
| Codex（OpenAI） | https://developers.openai.com/api/docs/pricing |

要找的數字（美元 / 百萬 token，標準方案，不是 Batch、不是 Priority）：
- `input` 輸入、`output` 輸出
- `cacheRead`：Claude 的 cache hits / cache reads；OpenAI 的 cached input
- Claude 的快取寫入：`cacheWrite5m`（5 分鐘）、`cacheWrite1h`（1 小時）。官方剛好是輸入價格的 1.25 倍 / 2 倍時可以省略
- 長上下文價格：只在官方有列時才填 `long: { "threshold": 提示 token 門檻, "input", "output", "cacheRead" }`（例如 OpenAI 部分模型超過 272K、Claude Haiku 5.5 超過 100K）

優先處理 `unpriced` 裡的模型，再檢查 `seenModels` 用到的模型價格有沒有變。官方頁面沒有列出的模型**不要猜**，告訴使用者找不到。

### 3. 列出差異，等使用者確認

用表格列出每一筆變更：工具、模型、欄位、目前價格 → 官方價格、來源網址。新增的模型也列出來。沒有變動就直接告訴使用者「價格都是最新的」，不需要寫入。

問使用者要套用哪些，**等明確回答**。

### 4. 寫入使用者同意的部分

把同意的變更寫成 JSON 檔（放在暫存資料夾），格式：

```json
{
  "changes": [
    { "tool": "codex", "model": "gpt-5.5", "input": 5, "output": 30, "cacheRead": 0.5,
      "long": { "threshold": 272000, "input": 10, "output": 45, "cacheRead": 1 },
      "sourceUrl": "https://developers.openai.com/api/docs/pricing" },
    { "tool": "claude", "model": "claude-opus-5-5", "input": 4, "output": 20, "cacheRead": 0.2,
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing" }
  ]
}
```

`tool` 只能是 `claude` 或 `codex`；`model` 用模型的完整 ID（和 `seenModels` 裡的寫法一樣）。然後執行：

```bash
node "SCRIPTS/prices.js" apply "<JSON 檔路徑>"
```

結果會列出 `applied`（已寫入）和 `skipped`（略過的原因）。使用者在儀表板手動改過的價格不會被覆蓋；只有使用者明確要求時才加 `--force`。

### 5. 回報

告訴使用者更新了哪些模型；儀表板的「模型價格」會把這些標成「AI 更新」，花費會自動重新計算。提醒他：plugin 作者發布較新的官方價格表後，AI 更新的價格會自動改用官方價格表。
